//! Native window screenshot capture (Windows GDI).
//!
//! WebView2 renders through DirectComposition, so the usual `BitBlt` of a
//! window DC can come back empty. `PrintWindow` with `PW_RENDERFULLCONTENT`
//! asks the window to render itself into our memory DC, which works for
//! WebView2; `BitBlt` stays as a fallback for older compositors.

use std::ffi::c_void;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

type Hwnd = *mut c_void;
type Hdc = *mut c_void;
type Hbitmap = *mut c_void;
type Hgdiobj = *mut c_void;

#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct BitmapInfoHeader {
    bi_size: u32,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels_per_meter: i32,
    bi_y_pels_per_meter: i32,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

#[repr(C)]
struct RgbQuad {
    blue: u8,
    green: u8,
    red: u8,
    reserved: u8,
}

#[repr(C)]
struct BitmapInfo {
    header: BitmapInfoHeader,
    colors: [RgbQuad; 1],
}

#[link(name = "user32")]
extern "system" {
    fn GetWindowRect(hwnd: Hwnd, rect: *mut Rect) -> i32;
    fn GetDC(hwnd: Hwnd) -> Hdc;
    fn ReleaseDC(hwnd: Hwnd, hdc: Hdc) -> i32;
    fn PrintWindow(hwnd: Hwnd, hdc: Hdc, flags: u32) -> i32;
}

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
    fn CreateCompatibleBitmap(hdc: Hdc, width: i32, height: i32) -> Hbitmap;
    fn SelectObject(hdc: Hdc, obj: Hgdiobj) -> Hgdiobj;
    fn BitBlt(dest: Hdc, x: i32, y: i32, w: i32, h: i32, src: Hdc, sx: i32, sy: i32, rop: u32) -> i32;
    fn GetDIBits(hdc: Hdc, bmp: Hbitmap, start: u32, lines: u32, bits: *mut c_void, info: *mut BitmapInfo, usage: u32) -> i32;
    fn DeleteObject(obj: Hgdiobj) -> i32;
    fn DeleteDC(hdc: Hdc) -> i32;
}

const SRCCOPY: u32 = 0x00CC_0020;
const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;
const DIB_RGB_COLORS: u32 = 0;
const BI_RGB: u32 = 0;

fn capture_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("Pictures").join("GeoPlayer")
}

fn unique_path(dir: &Path) -> PathBuf {
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    let mut path = dir.join(format!("GeoPlayer_{stamp}.png"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("GeoPlayer_{stamp}-{n}.png"));
        n += 1;
    }
    path
}

fn mostly_blank(buf: &[u8]) -> bool {
    if buf.is_empty() {
        return true;
    }
    let mut lit = 0usize;
    let step = 4 * 97; // sample ~1% of pixels, always 4-byte aligned
    let mut i = 0;
    let mut sampled = 0usize;
    while i + 3 < buf.len() {
        if (buf[i] as u32) + (buf[i + 1] as u32) + (buf[i + 2] as u32) > 18 {
            lit += 1;
        }
        sampled += 1;
        i += step;
    }
    sampled > 0 && (lit as f64 / sampled as f64) < 0.005
}

pub fn capture(window: &tauri::WebviewWindow) -> Result<String, String> {
    if window.is_minimized().unwrap_or(false) {
        return Err("The GeoPlayer window is minimized. Restore it and try again.".into());
    }

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Cannot access the window handle: {e}"))?
        .0 as Hwnd;

    unsafe {
        let mut rect = Rect::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err("Cannot measure the GeoPlayer window.".into());
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err("The GeoPlayer window has no drawable area.".into());
        }

        let window_dc = GetDC(hwnd);
        if window_dc.is_null() {
            return Err("Cannot obtain a device context for the window.".into());
        }
        let mem_dc = CreateCompatibleDC(window_dc);
        let bitmap = CreateCompatibleBitmap(window_dc, width, height);
        if mem_dc.is_null() || bitmap.is_null() {
            if !mem_dc.is_null() {
                DeleteDC(mem_dc);
            }
            ReleaseDC(hwnd, window_dc);
            return Err("Cannot allocate a capture buffer.".into());
        }
        let old = SelectObject(mem_dc, bitmap);

        let mut printed = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT) != 0;

        let mut info = BitmapInfo {
            header: BitmapInfoHeader {
                bi_size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                bi_width: width,
                bi_height: -height, // top-down rows
                bi_planes: 1,
                bi_bit_count: 32,
                bi_compression: BI_RGB,
                bi_size_image: 0,
                bi_x_pels_per_meter: 0,
                bi_y_pels_per_meter: 0,
                bi_clr_used: 0,
                bi_clr_important: 0,
            },
            colors: [RgbQuad { blue: 0, green: 0, red: 0, reserved: 0 }],
        };
        let mut buf = vec![0u8; width as usize * height as usize * 4];

        let read = |buf: &mut [u8], info: &mut BitmapInfo| -> bool {
            GetDIBits(
                mem_dc,
                bitmap,
                0,
                height as u32,
                buf.as_mut_ptr() as *mut c_void,
                info,
                DIB_RGB_COLORS,
            ) != 0
        };

        let mut ok = read(&mut buf, &mut info);
        if printed && ok && mostly_blank(&buf) {
            printed = false; // PrintWindow returned an empty frame; retry with BitBlt
        }
        if !printed {
            BitBlt(mem_dc, 0, 0, width, height, window_dc, 0, 0, SRCCOPY);
            ok = read(&mut buf, &mut info);
        }

        SelectObject(mem_dc, old);
        DeleteObject(bitmap);
        DeleteDC(mem_dc);
        ReleaseDC(hwnd, window_dc);

        if !ok {
            return Err("Windows did not return any pixels for the GeoPlayer window.".into());
        }
        if mostly_blank(&buf) {
            return Err("The capture came back blank. Bring GeoPlayer to the front and try again.".into());
        }

        // GDI hands back BGRA; PNG wants RGBA. Window captures carry no alpha.
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        let dir = capture_path();
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
        let path = unique_path(&dir);

        let file = std::fs::File::create(&path)
            .map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
        let mut encoder = png::Encoder::new(BufWriter::new(file), width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("Cannot write PNG header: {e}"))?;
        writer
            .write_image_data(&buf)
            .map_err(|e| format!("Cannot write PNG data: {e}"))?;
        writer
            .finish()
            .map_err(|e| format!("Cannot finish PNG: {e}"))?;

        Ok(path.to_string_lossy().into_owned())
    }
}

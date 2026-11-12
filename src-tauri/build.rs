fn main() {
    // tauri-build only re-runs when the config changes, so a new app icon
    // would otherwise never be compiled into the Windows resource.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");

    let attributes = tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("windows-app-manifest.xml")),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

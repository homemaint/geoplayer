import { Component, type ReactNode } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
}

/** Last-resort UI boundary — a component crash shows a recoverable message, not a dead app. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[GeoPlayer] UI error:", error, info?.componentStack ?? "");
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-fallback" role="alert">
          <CircleAlert size={34} strokeWidth={1.6} />
          <b>Something glitched in {this.props.label ?? "the UI"}</b>
          <span className="error-fallback__msg">{this.state.error.message}</span>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

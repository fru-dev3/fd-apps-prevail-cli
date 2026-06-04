import React from "react";
import { theme } from "./theme.ts";
import { logDebug } from "./debug-log.ts";

interface Props {
  name: string;          // pane name for the error display + debug log
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    try {
      logDebug("react.errorboundary", `${this.props.name} crashed`, {
        message: error.message,
        stack: error.stack?.slice(0, 4000),
        componentStack: info.componentStack?.slice(0, 2000),
      });
    } catch {
      // logger is best-effort; don't double-fault here
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <box flexDirection="column" padding={2}>
          <text fg={theme.warn ?? theme.gold} attributes={1}>
            ! {this.props.name} crashed
          </text>
          <text fg={theme.fgDim}>
            {this.state.error?.message ?? "no message"}
          </text>
          <text> </text>
          <text fg={theme.fgFaint}>
            full trace appended to ~/.prevail/debug.log
          </text>
          <text fg={theme.fgFaint}>
            press R to reload the cockpit · q to quit
          </text>
        </box>
      );
    }
    return this.props.children;
  }
}

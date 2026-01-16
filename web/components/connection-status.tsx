import type { ConnectionStatus } from "../hooks/use-websocket";

interface ConnectionStatusProps {
  status: ConnectionStatus;
}

export function ConnectionStatusIndicator(props: ConnectionStatusProps) {
  const { status } = props;

  const statusConfig = {
    connected: {
      color: "bg-emerald-500",
      label: "Connected",
    },
    connecting: {
      color: "bg-amber-500 animate-pulse",
      label: "Connecting",
    },
    disconnected: {
      color: "bg-zinc-500",
      label: "Disconnected",
    },
  };

  const config = statusConfig[status];

  return (
    <span
      className={`h-2 w-2 rounded-full ${config.color}`}
      title={config.label}
    />
  );
}

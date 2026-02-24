import type { AztecConnectionStatus } from '../hooks/useAztec';
import './WalletStatus.css';

interface WalletStatusProps {
  status: AztecConnectionStatus;
  address: string | null;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

export function WalletStatus({
  status,
  address,
  error,
  onConnect,
  onDisconnect,
}: WalletStatusProps) {
  const getStatusIndicator = () => {
    switch (status) {
      case 'connected':
        return 'wallet-status__dot--connected';
      case 'connecting':
        return 'wallet-status__dot--connecting';
      case 'error':
        return 'wallet-status__dot--error';
      case 'unsupported':
        return 'wallet-status__dot--unsupported';
      default:
        return 'wallet-status__dot--disconnected';
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'error':
        return 'Error';
      case 'unsupported':
        return 'WebSocket Only';
      default:
        return 'Disconnected';
    }
  };

  const truncateAddress = (addr: string) => {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <div className="wallet-status">
      <div className="wallet-status__info">
        <span className={`wallet-status__dot ${getStatusIndicator()}`} />
        <span className="wallet-status__text">{getStatusText()}</span>
        {address && (
          <span className="wallet-status__address" title={address}>
            {truncateAddress(address)}
          </span>
        )}
      </div>
      <div className="wallet-status__actions">
        {status === 'disconnected' && (
          <button
            className="btn btn--small btn--primary"
            onClick={onConnect}
          >
            Connect Wallet
          </button>
        )}
        {status === 'connected' && (
          <button
            className="btn btn--small btn--ghost"
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        )}
        {status === 'error' && (
          <button
            className="btn btn--small btn--primary"
            onClick={onConnect}
          >
            Retry
          </button>
        )}
      </div>
      {error && status === 'error' && (
        <div className="wallet-status__error" title={error}>
          {error.length > 50 ? error.slice(0, 50) + '...' : error}
        </div>
      )}
    </div>
  );
}

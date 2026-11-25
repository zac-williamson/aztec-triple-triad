import { useState } from 'react';
import type { StuckGame, StuckGameKind } from '../hooks/useGame';
import type { ConnectionStatus } from '../hooks/useAztec';
import './MainMenu.css';

/**
 * One badge for two links: the relay (game server) and the Aztec node. It used
 * to show only the relay, so when the testnet RPC died (Oct 2026) the menu said
 * "Connected" over 0 cards and a disabled Play button, with the real error only
 * in the console. It now reports the weaker of the two.
 */
export function connectionBadge(
  relayConnected: boolean,
  aztecStatus: ConnectionStatus,
): { label: string; tone: 'ok' | 'pending' | 'error' } {
  if (aztecStatus === 'error') return { label: 'Aztec network unavailable', tone: 'error' };
  if (aztecStatus === 'unsupported') return { label: 'Aztec disabled', tone: 'error' };
  if (!relayConnected) return { label: 'Connecting to game server...', tone: 'pending' };
  if (aztecStatus === 'needs-funding') return { label: 'Account needs funding', tone: 'pending' };
  if (aztecStatus === 'choosing-wallet') return { label: 'Choose a wallet', tone: 'pending' };
  if (aztecStatus === 'nulo-connecting') return { label: 'Connecting to Nulo...', tone: 'pending' };
  if (aztecStatus === 'connected') return { label: 'Connected', tone: 'ok' };
  return { label: 'Connecting to Aztec...', tone: 'pending' };
}

/** Stuck games the player can act on now: what to say, and what the button does. */
const RECOVERABLE: Partial<Record<StuckGameKind, { text: string; button: string; note: string }>> = {
  cancellable: {
    text: 'Five of your cards are committed to a game nobody joined.',
    button: 'Cancel Game & Recover Cards',
    note: 'Cancels the game on-chain and returns your hand. This starts by itself when you are back on the menu.',
  },
  settleable: {
    text: 'Your last game finished but was never settled.',
    button: 'Settle Game',
    note: 'Settles it from the moves you both proved. Each player then collects their own cards and reward.',
  },
  claimable: {
    text: 'Five of your cards are still committed to an unfinished game.',
    button: 'Recover My Cards',
    note: 'Claims the game abandoned. After a ten-minute dispute window you get your five cards back, plus one of your opponent\'s open cards: walking away from a game costs a card. It takes a while — keep this tab open.',
  },
  finalizable: {
    text: 'Your last game was claimed abandoned and nobody objected in time.',
    button: 'Recover My Cards',
    note: 'Ends the game: whoever claimed it gets their five cards back plus the open card the claim took, and the other player gets their remaining cards. This starts by itself when you are back on the menu.',
  },
};

/** Stuck games the player can only wait on. */
const WAITING: Partial<Record<StuckGameKind, { text: string; note: (minutes: number) => string }>> = {
  'too-soon': {
    text: 'Five of your cards are committed to a game that has not finished.',
    note: m => `You can recover them if your opponent does not come back. That becomes available about ${m} minutes from now — the wait is what stops a claim being used to cut a live game short.`,
  },
  'claim-pending': {
    text: 'Your last game has been claimed abandoned.',
    note: m => `The dispute window closes in about ${m} minutes. After that the game ends and your cards come back by themselves — less one open card if the claim was against you.`,
  },
  'awaiting-winner': {
    text: 'Your last game finished and is waiting to be settled.',
    note: m => `The winner settles it. If they have not in about ${m} minutes, you can settle it yourself.`,
  },
};

interface MainMenuProps {
  connected: boolean;
  aztecStatus: ConnectionStatus;
  /** Why the Aztec connection failed, when aztecStatus is 'error'. */
  aztecError: string | null;
  /** Start over after an Aztec failure (the app reloads: the wallet store may hold a lock). */
  onRetryAztec: () => void;
  /** Which wallet holds the account; the in-browser wallet's repair tools only apply to it. */
  walletKind?: 'embedded' | 'nulo' | null;
  /** Forget the wallet choice and ask again. */
  onSwitchWallet?: () => void;
  aztecConnecting: boolean;
  aztecReady: boolean;
  cardCount: number;
  tokenBalance: number;
  accountAddress: string | null;
  hasGameInProgress: boolean;
  /** A game still holding this player's cards on-chain, if any. */
  stuckGame: StuckGame | null;
  isRecovering: boolean;
  onRecoverStuckGame: () => void;
  onContestClaim: () => void;
  onPlay: () => void;
  onTutorial: () => void;
  onPractice: () => void;
  onCardPacks: () => void;
}

export function MainMenu({
  connected,
  aztecStatus,
  aztecError,
  onRetryAztec,
  walletKind,
  onSwitchWallet,
  aztecConnecting,
  aztecReady,
  cardCount,
  tokenBalance,
  accountAddress,
  hasGameInProgress,
  stuckGame,
  isRecovering,
  onRecoverStuckGame,
  onContestClaim,
  onPlay,
  onTutorial,
  onPractice,
  onCardPacks,
}: MainMenuProps) {
  const [showNotEnoughCards, setShowNotEnoughCards] = useState(false);

  const canPlay = connected && aztecReady;
  const badge = connectionBadge(connected, aztecStatus);
  const aztecDown = badge.tone === 'error';

  const handlePlayClick = () => {
    if (cardCount < 5) {
      setShowNotEnoughCards(true);
    } else {
      onPlay();
    }
  };

  return (
    <div className="main-menu">
      <div className="main-menu__header">
        <h1 className="main-menu__title">Axolotl Arena</h1>
        <p className="main-menu__subtitle">Powered by Aztec Network</p>
        <div
          className={`main-menu__status main-menu__status--${badge.tone}`}
          data-testid="connection-status"
        >
          {badge.label}
        </div>
        {aztecStatus === 'error' && (
          <div className="main-menu__aztec-error" role="alert" data-testid="aztec-error">
            <p className="main-menu__aztec-error-text">
              Can&apos;t connect to the Aztec network, so games can&apos;t start right now.
              Practice vs Bot still works.
            </p>
            {aztecError && <code className="main-menu__aztec-error-detail">{aztecError.slice(0, 200)}</code>}
            <button className="main-menu__aztec-retry" data-testid="aztec-retry" onClick={onRetryAztec}>
              Retry
            </button>
          </div>
        )}
        {connected && accountAddress && (
          <div style={{
            fontFamily: 'monospace',
            fontSize: 11,
            color: '#8a7a64',
            marginTop: 4,
            wordBreak: 'break-all',
            maxWidth: 400,
            textAlign: 'center',
          }}>
            {accountAddress}
          </div>
        )}
        {connected && (
          <div className="main-menu__token-balance" style={{
            fontFamily: "'Cinzel', serif",
            fontSize: 14,
            color: '#c8a860',
            marginTop: 8,
          }}>
            Arena Tokens: {tokenBalance} | Cards: {cardCount}
          </div>
        )}
      </div>

      <div className="main-menu__buttons">
        <button
          className="main-menu__btn main-menu__btn--play"
          data-testid="menu-play"
          onClick={handlePlayClick}
          disabled={!canPlay}
          title={canPlay ? undefined : badge.label}
        >
          <span className="main-menu__btn-icon">&#9876;</span>
          {hasGameInProgress ? 'Resume' : 'Play'}
        </button>

        <button
          className="main-menu__btn main-menu__btn--tutorial"
          onClick={onTutorial}
        >
          <span className="main-menu__btn-icon">&#128214;</span>
          Tutorial
        </button>

        <button
          className="main-menu__btn main-menu__btn--practice"
          onClick={onPractice}
        >
          <span className="main-menu__btn-icon">&#129302;</span>
          Practice vs Bot
        </button>

        <button
          className="main-menu__btn main-menu__btn--packs"
          data-testid="menu-packs"
          onClick={onCardPacks}
          disabled={!connected || aztecDown}
        >
          <span className="main-menu__btn-icon">&#127183;</span>
          Buy Card Pack
        </button>
      </div>

      {aztecConnecting && (
        <p className="main-menu__card-status">Loading your cards from Aztec...</p>
      )}

      {/* Cards locked in a game nobody finished. Every one of these offers is
          something the contract will accept right now (aztec/stuckGame.ts). */}
      {stuckGame && RECOVERABLE[stuckGame.kind] && (
        <div className="main-menu__stuck" data-testid="stuck-game" data-kind={stuckGame.kind}>
          <p className="main-menu__stuck-text">{RECOVERABLE[stuckGame.kind]!.text}</p>
          <button
            className="main-menu__btn main-menu__btn--recover"
            data-testid="recover-stuck-game"
            onClick={onRecoverStuckGame}
            disabled={isRecovering || !connected}
          >
            {isRecovering ? 'Recovering your cards…' : RECOVERABLE[stuckGame.kind]!.button}
          </button>
          <p className="main-menu__stuck-note">{RECOVERABLE[stuckGame.kind]!.note}</p>
        </div>
      )}

      {/* The contract will not accept anything yet, so we offer nothing — we
          say how long. */}
      {stuckGame && WAITING[stuckGame.kind] && (
        <div className="main-menu__stuck" data-testid={`stuck-game-${stuckGame.kind}`}>
          <p className="main-menu__stuck-text">{WAITING[stuckGame.kind]!.text}</p>
          <p className="main-menu__stuck-note">
            {WAITING[stuckGame.kind]!.note(Math.max(1, Math.round((stuckGame.waitSeconds ?? 0) / 60)))}
          </p>
        </div>
      )}

      {/* The other half of the dispute window: somebody has claimed our game
          as abandoned and we are here to say otherwise. */}
      {stuckGame?.kind === 'contestable' && (
        <div className="main-menu__stuck" data-testid="stuck-game-contestable">
          <p className="main-menu__stuck-text">
            Your opponent has claimed your last game was abandoned.
          </p>
          <button
            className="main-menu__btn main-menu__btn--recover"
            data-testid="contest-claim"
            onClick={onContestClaim}
            disabled={isRecovering || !connected}
          >
            {isRecovering ? 'Contesting…' : "I'm Still Here — Contest"}
          </button>
          <p className="main-menu__stuck-note">
            Contesting cancels their claim, and the card it would take from
            you, and puts the game back in play. You can do this once per
            game, so finish the game afterwards.
          </p>
        </div>
      )}

      {/* Both were `position: fixed; bottom: 16px; right: 16px`, so they sat on
          top of each other. One row that owns the corner; the buttons lay
          themselves out inside it. */}
      <div className="main-menu__utility-bar">
        {onSwitchWallet && (
          <button
            className="main-menu__btn-clear"
            data-testid="switch-wallet"
            title={walletKind === 'nulo'
              ? 'Disconnects Nulo and asks which wallet to use. Nothing is deleted.'
              : 'Asks which wallet to use. Your in-browser account and cards are kept.'}
            onClick={onSwitchWallet}
          >
            Switch Wallet{walletKind === 'nulo' ? ' (Nulo)' : ''}
          </button>
        )}

        {walletKind !== 'nulo' && (<>
        <button
          className="main-menu__btn-clear"
          data-testid="repair-chain-sync"
          title="Rebuilds local chain-sync state (fixes 'PXE chain-sync is wedged' errors). Your account and cards are kept."
          onClick={async () => {
            const { repairChainSync } = await import('../aztec/connectToAztec');
            repairChainSync();
          }}
        >
          Repair Chain Sync
        </button>

        <button
          className="main-menu__btn-clear main-menu__btn-clear--destructive"
          data-testid="clear-all-state"
          title="Deletes this browser's account, keys and cards. There is no undo, and nothing is recoverable afterwards."
          onClick={async () => {
            const { clearAllState } = await import('../aztec/connectToAztec');
            clearAllState();
          }}
        >
          Clear All State
        </button>
        </>)}
      </div>

      {showNotEnoughCards && (
        <div className="main-menu__dialog-overlay" onClick={() => setShowNotEnoughCards(false)}>
          <div className="main-menu__dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="main-menu__dialog-title">Not Enough Cards</h3>
            <p className="main-menu__dialog-text">
              You need at least 5 cards to play. You currently have {cardCount}.
            </p>
            <p className="main-menu__dialog-text">
              Visit <strong>Card Packs</strong> to get more cards.
            </p>
            <button
              className="main-menu__btn main-menu__btn--play"
              onClick={() => setShowNotEnoughCards(false)}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

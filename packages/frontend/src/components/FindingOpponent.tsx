import { GameTips } from './GameTips';
import './FindingOpponent.css';

interface FindingOpponentProps {
  queuePosition: number | null;
  onCancel: () => void;
}

export function FindingOpponent({ queuePosition, onCancel }: FindingOpponentProps) {
  return (
    <div className="finding-opponent">
      <div className="finding-opponent__dialog">
        <h2 className="finding-opponent__header">Finding Opponent...</h2>

        <div className="finding-opponent__scene">
          <img className="finding-opponent__pixel-art" src="/ui-elements/swamp.gif" alt="Swamp scene" draggable={false} />
          {/* Animated fireflies overlay */}
          <div className="finding-opponent__fireflies">
            <div className="finding-opponent__firefly" />
            <div className="finding-opponent__firefly" />
            <div className="finding-opponent__firefly" />
            <div className="finding-opponent__firefly" />
            <div className="finding-opponent__firefly" />
          </div>
        </div>

        {queuePosition !== null && (
          <div className="finding-opponent__queue">
            Queue position: {queuePosition}
          </div>
        )}

        <GameTips />

        <button className="finding-opponent__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

import { GameTips } from './GameTips';
import './FindingOpponent.css';

interface FindingOpponentProps {
  queuePosition: number | null;
  onCancel: () => void;
}

export function FindingOpponent({ queuePosition, onCancel }: FindingOpponentProps) {
  return (
    <div className="finding-opponent">
      <h2 className="finding-opponent__header">Finding Opponent...</h2>

      <div className="finding-opponent__animation">
        {/* Placeholder axolotl silhouette */}
        <div className="finding-opponent__axolotl">
          <div className="finding-opponent__tail" />
        </div>

        {/* Bug target */}
        <div className="finding-opponent__bug" />

        {/* Orbiting dots */}
        <div className="finding-opponent__dots">
          <div className="finding-opponent__dot" />
          <div className="finding-opponent__dot" />
          <div className="finding-opponent__dot" />
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
  );
}

import { useState, useEffect } from 'react';

const TIPS = [
  'Cards with high values on multiple edges are harder to capture!',
  'Place cards in corners to protect two edges at once.',
  "Watch your opponent's remaining cards to predict their strategy.",
  "The winner claims one card from the loser's collection!",
  'Control more cards when the board fills up to win!',
  'Hunt for card packs to expand your collection.',
  'Rare and legendary cards have higher rank totals.',
  'A card with rank 10 (A) on one edge can be a powerful finisher.',
  "Try to bait your opponent into placing next to your strongest edge.",
  "Don't forget: captures chain! One placement can flip multiple cards.",
];

export function GameTips() {
  const [index, setIndex] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        setIndex(prev => (prev + 1) % TIPS.length);
        setFading(false);
      }, 400);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      style={{
        fontFamily: "'Nunito', sans-serif",
        fontSize: '14px',
        color: 'rgba(232, 228, 216, 0.5)',
        fontStyle: 'italic',
        textAlign: 'center',
        maxWidth: '400px',
        minHeight: '40px',
        transition: 'opacity 0.4s ease',
        opacity: fading ? 0 : 1,
      }}
    >
      {TIPS[index]}
    </div>
  );
}

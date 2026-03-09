/// Shared card rank database for Triple Triad circuits.
/// 50 cards with ranks [top, right, bottom, left], IDs 1-50.
///
/// Used by both prove_hand and game_move circuits.
pub fn get_card_ranks(card_id: u32) -> [Field; 4] {
    assert((card_id >= 1) & (card_id <= 50), "Invalid card ID for rank lookup");

    // Level 1 - Common (IDs 1-10)
    if card_id == 1 { [1, 4, 1, 5] }        // Mudwalker
    else if card_id == 2 { [5, 1, 1, 3] }    // Blushy
    else if card_id == 3 { [1, 3, 3, 5] }    // Snowdrop
    else if card_id == 4 { [6, 1, 1, 2] }    // Sunny
    else if card_id == 5 { [2, 3, 1, 5] }    // Inkwell
    else if card_id == 6 { [2, 1, 4, 4] }    // Stripes
    else if card_id == 7 { [1, 5, 4, 1] }    // Barkeeper
    else if card_id == 8 { [3, 1, 5, 2] }    // Dotty
    else if card_id == 9 { [2, 1, 6, 1] }    // Penny
    else if card_id == 10 { [4, 3, 2, 4] }   // Peaches
    // Level 2 - Uncommon (IDs 11-20)
    else if card_id == 11 { [2, 6, 1, 6] }   // Freckles
    else if card_id == 12 { [7, 1, 3, 1] }   // Camo
    else if card_id == 13 { [6, 2, 2, 3] }   // Neon
    else if card_id == 14 { [5, 3, 3, 4] }   // Glow Bug
    else if card_id == 15 { [6, 1, 4, 3] }   // Limelight
    else if card_id == 16 { [3, 4, 5, 3] }   // Marble
    else if card_id == 17 { [5, 3, 2, 5] }   // Sapphire
    else if card_id == 18 { [5, 1, 3, 5] }   // Jefferson
    else if card_id == 19 { [5, 2, 5, 2] }   // Longfoot
    else if card_id == 20 { [4, 2, 4, 5] }   // Featherfin
    // Level 3 - Rare (IDs 21-30)
    else if card_id == 21 { [3, 7, 2, 5] }   // Lilac
    else if card_id == 22 { [5, 2, 5, 5] }   // Patches
    else if card_id == 23 { [6, 6, 3, 3] }   // Faded
    else if card_id == 24 { [6, 3, 6, 3] }   // Gold Dust
    else if card_id == 25 { [3, 5, 5, 5] }   // Phantom
    else if card_id == 26 { [7, 5, 1, 3] }   // Ash
    else if card_id == 27 { [7, 1, 5, 3] }   // Cocoa
    else if card_id == 28 { [5, 3, 6, 3] }   // Ringmaster
    else if card_id == 29 { [5, 6, 2, 4] }   // Goldrush
    else if card_id == 30 { [4, 4, 7, 2] }   // Swampling
    // Level 4 - Epic (IDs 31-40)
    else if card_id == 31 { [3, 6, 4, 7] }   // Glitter
    else if card_id == 32 { [7, 2, 3, 7] }   // Starfield
    else if card_id == 33 { [2, 3, 7, 7] }   // Specter
    else if card_id == 34 { [6, 5, 5, 5] }   // Saffron
    else if card_id == 35 { [4, 7, 6, 2] }   // Stardust
    else if card_id == 36 { [2, 3, 7, 8] }   // Achoque
    else if card_id == 37 { [1, 7, 6, 4] }   // Zacapu
    else if card_id == 38 { [7, 3, 1, 6] }   // Laguna
    else if card_id == 39 { [7, 4, 4, 4] }   // Streamwalker
    else if card_id == 40 { [3, 7, 3, 6] }   // Digger
    // Level 5 - Legendary (IDs 41-50)
    else if card_id == 41 { [6, 7, 3, 7] }   // Eclipse
    else if card_id == 42 { [6, 5, 8, 4] }   // Kaleidoscope
    else if card_id == 43 { [6, 5, 6, 6] }   // Twinned
    else if card_id == 44 { [3, 6, 7, 8] }   // Sparkletail
    else if card_id == 45 { [7, 6, 5, 6] }   // Riddler
    else if card_id == 46 { [3, 10, 2, 1] }  // Rosita
    else if card_id == 47 { [6, 2, 6, 7] }   // Brooklet
    else if card_id == 48 { [5, 5, 7, 6] }   // Whisper
    else if card_id == 49 { [7, 7, 4, 2] }   // Misty
    else { [7, 2, 7, 4] }                    // Lerma (card_id == 50)
}

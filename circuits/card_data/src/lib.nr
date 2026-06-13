/// Shared card rank database for Triple Triad circuits.
/// 256 cards with ranks [top, right, bottom, left], IDs 1-256.
///
/// Used by both prove_hand and game_move circuits.
///
/// Stored as a flat lookup table: the previous 256-arm nested if/else
/// expression overflows noirc's TYPE_RECURSION_LIMIT (100) during
/// type-checking on nargo 1.0.0-beta.21 whenever another dependency
/// (e.g. poseidon) shares the compilation unit.
global CARD_RANKS: [[Field; 4]; 256] = [
    [1, 4, 1, 5], // 1 Mudwalker
    [5, 1, 1, 3], // 2 Blushy
    [1, 3, 3, 5], // 3 Snowdrop
    [6, 1, 1, 2], // 4 Sunny
    [2, 3, 1, 5], // 5 Inkwell
    [2, 1, 4, 4], // 6 Stripes
    [1, 5, 4, 1], // 7 Barkeeper
    [3, 1, 5, 2], // 8 Dotty
    [2, 1, 6, 1], // 9 Penny
    [4, 3, 2, 4], // 10 Peaches
    [2, 6, 1, 6], // 11 Freckles
    [7, 1, 3, 1], // 12 Camo
    [6, 2, 2, 3], // 13 Neon
    [5, 3, 3, 4], // 14 Glow Bug
    [6, 1, 4, 3], // 15 Limelight
    [3, 4, 5, 3], // 16 Marble
    [5, 3, 2, 5], // 17 Sapphire
    [5, 1, 3, 5], // 18 Jefferson
    [5, 2, 5, 2], // 19 Longfoot
    [4, 2, 4, 5], // 20 Featherfin
    [3, 7, 2, 5], // 21 Lilac
    [5, 2, 5, 5], // 22 Patches
    [6, 6, 3, 3], // 23 Faded
    [6, 3, 6, 3], // 24 Gold Dust
    [3, 5, 5, 5], // 25 Phantom
    [7, 5, 1, 3], // 26 Ash
    [7, 1, 5, 3], // 27 Cocoa
    [5, 3, 6, 3], // 28 Ringmaster
    [5, 6, 2, 4], // 29 Goldrush
    [4, 4, 7, 2], // 30 Swampling
    [3, 6, 4, 7], // 31 Glitter
    [7, 2, 3, 7], // 32 Starfield
    [2, 3, 7, 7], // 33 Specter
    [6, 5, 5, 5], // 34 Saffron
    [4, 7, 6, 2], // 35 Stardust
    [2, 3, 7, 8], // 36 Achoque
    [1, 7, 6, 4], // 37 Zacapu
    [7, 3, 1, 6], // 38 Laguna
    [7, 4, 4, 4], // 39 Streamwalker
    [3, 7, 3, 6], // 40 Digger
    [6, 7, 3, 7], // 41 Eclipse
    [6, 5, 8, 4], // 42 Kaleidoscope
    [6, 5, 6, 6], // 43 Twinned
    [3, 6, 7, 8], // 44 Sparkletail
    [7, 6, 5, 6], // 45 Riddler
    [3, 10, 2, 1], // 46 Rosita
    [6, 2, 6, 7], // 47 Brooklet
    [5, 5, 7, 6], // 48 Whisper
    [7, 7, 4, 2], // 49 Misty
    [7, 2, 7, 4], // 50 Lerma
    [4, 2, 6, 3], // 51 Puddle
    [2, 5, 3, 6], // 52 Trickle
    [5, 1, 4, 5], // 53 Dewdrop
    [2, 4, 1, 6], // 54 Sprout
    [3, 2, 4, 5], // 55 Nibbles
    [4, 2, 5, 2], // 56 Pebble
    [2, 1, 5, 5], // 57 Clover
    [6, 1, 6, 3], // 58 Dapple
    [5, 1, 6, 3], // 59 Flicker
    [1, 5, 2, 6], // 60 Rustle
    [4, 5, 2, 2], // 61 Wisp
    [4, 3, 6, 3], // 62 Bramble
    [4, 1, 6, 4], // 63 Thistle
    [4, 4, 2, 5], // 64 Burrow
    [5, 2, 6, 2], // 65 Cricket
    [2, 4, 5, 1], // 66 Minnow
    [2, 4, 1, 5], // 67 Pinecone
    [3, 3, 1, 6], // 68 Acorn
    [3, 5, 2, 3], // 69 Mushroom
    [4, 3, 3, 4], // 70 Fiddlehead
    [5, 6, 2, 2], // 71 Tadpole
    [2, 3, 5, 4], // 72 Drizzle
    [2, 6, 3, 1], // 73 Duskweed
    [2, 6, 3, 5], // 74 Cattail
    [1, 2, 6, 6], // 75 Bulrush
    [1, 4, 6, 5], // 76 Lichen
    [2, 3, 4, 6], // 77 Toadskin
    [4, 1, 5, 2], // 78 Barnacle
    [2, 3, 6, 1], // 79 Kelp
    [3, 5, 2, 5], // 80 Driftwood
    [6, 2, 2, 4], // 81 Ripple
    [1, 6, 5, 3], // 82 Current
    [6, 3, 1, 4], // 83 Eddy
    [1, 6, 2, 5], // 84 Brook
    [5, 1, 6, 2], // 85 Mossheart
    [3, 4, 6, 1], // 86 Reedling
    [6, 5, 1, 1], // 87 Fernback
    [5, 3, 2, 4], // 88 Cobble
    [6, 1, 1, 6], // 89 Shingle
    [6, 4, 1, 2], // 90 Dampfoot
    [3, 6, 1, 5], // 91 Mudskipper
    [2, 5, 3, 5], // 92 Puddlejump
    [4, 1, 3, 6], // 93 Bogbean
    [1, 4, 6, 4], // 94 Waterlily
    [6, 5, 4, 1], // 95 Pondweed
    [1, 2, 6, 6], // 96 Duckweed
    [3, 2, 3, 5], // 97 Silverfin
    [2, 6, 1, 6], // 98 Quicksand
    [4, 6, 4, 2], // 99 Rainfall
    [3, 5, 3, 2], // 100 Foghorn
    [6, 3, 2, 5], // 101 Mistletoe
    [5, 5, 2, 1], // 102 Juniper
    [1, 4, 5, 6], // 103 Hazelnut
    [1, 5, 5, 2], // 104 Walnut
    [6, 5, 1, 2], // 105 Chestnut
    [2, 3, 5, 4], // 106 Birchbark
    [2, 2, 4, 5], // 107 Pinewood
    [6, 3, 3, 4], // 108 Willowbend
    [2, 5, 4, 5], // 109 Elmshade
    [3, 4, 4, 3], // 110 Ashleaf
    [3, 3, 1, 5], // 111 Oakmoss
    [3, 4, 2, 3], // 112 Cedarbloom
    [5, 2, 1, 6], // 113 Magnolia
    [5, 3, 4, 2], // 114 Dahlia
    [4, 6, 1, 5], // 115 Poppy
    [1, 6, 2, 5], // 116 Marigold
    [1, 6, 2, 6], // 117 Buttercup
    [3, 2, 6, 4], // 118 Bluebell
    [4, 6, 2, 3], // 119 Foxglove
    [5, 3, 2, 5], // 120 Harebell
    [5, 4, 3, 3], // 121 Primrose
    [2, 4, 5, 5], // 122 Snapdragon
    [2, 6, 1, 6], // 123 Aster
    [2, 5, 1, 4], // 124 Zinnia
    [4, 1, 5, 5], // 125 Viola
    [5, 4, 2, 3], // 126 Petunia
    [6, 4, 3, 3], // 127 Hyacinth
    [6, 3, 3, 3], // 128 Crocus
    [4, 5, 6, 1], // 129 Tulip
    [5, 2, 6, 3], // 130 Iris
    [5, 4, 5, 2], // 131 Orchid
    [4, 4, 2, 6], // 132 Pansy
    [2, 4, 4, 4], // 133 Jasmine
    [1, 6, 2, 4], // 134 Lavender
    [3, 1, 6, 5], // 135 Rosemary
    [6, 1, 5, 3], // 136 Thyme
    [3, 2, 5, 6], // 137 Basil
    [3, 6, 3, 1], // 138 Sage
    [4, 4, 1, 5], // 139 Parsley
    [1, 6, 6, 3], // 140 Fennel
    [3, 3, 4, 3], // 141 Dill
    [2, 4, 3, 5], // 142 Chive
    [1, 6, 4, 1], // 143 Oregano
    [2, 6, 1, 4], // 144 Tarragon
    [6, 4, 2, 1], // 145 Anise
    [4, 3, 6, 1], // 146 Cardamom
    [5, 5, 1, 3], // 147 Cinnamon
    [1, 4, 1, 6], // 148 Ginger
    [6, 3, 6, 1], // 149 Nutmeg
    [4, 1, 1, 6], // 150 Saffie
    [1, 4, 5, 5], // 151 Tumeric
    [4, 5, 1, 3], // 152 Cayenne
    [1, 1, 5, 6], // 153 Paprika
    [6, 5, 3, 1], // 154 Cumin
    [4, 4, 1, 6], // 155 Coriander
    [6, 1, 3, 3], // 156 Clove
    [5, 3, 3, 3], // 157 Allspice
    [1, 4, 4, 6], // 158 Pimento
    [3, 6, 2, 4], // 159 Sumac
    [2, 3, 1, 6], // 160 Sesame
    [1, 6, 1, 5], // 161 Starflower
    [2, 6, 2, 3], // 162 Moonpetal
    [1, 5, 4, 5], // 163 Sundew
    [1, 5, 6, 1], // 164 Nightbloom
    [5, 2, 5, 4], // 165 Dawnbreeze
    [5, 4, 5, 1], // 166 Duskbell
    [2, 4, 6, 1], // 167 Twilight
    [2, 3, 2, 5], // 168 Gloaming
    [3, 5, 2, 6], // 169 Haze
    [5, 2, 3, 6], // 170 Vapor
    [4, 1, 6, 4], // 171 Cloudburst
    [6, 4, 1, 5], // 172 Sleet
    [5, 3, 5, 3], // 173 Drizzletail
    [2, 2, 4, 6], // 174 Steamvent
    [6, 2, 5, 2], // 175 Fogcrawler
    [3, 5, 3, 2], // 176 Mistwalker
    [5, 6, 5, 3], // 177 Abyssal
    [8, 3, 5, 2], // 178 Tidecaller
    [5, 5, 7, 2], // 179 Moonshadow
    [8, 3, 3, 8], // 180 Stormwarden
    [4, 7, 4, 3], // 181 Deeproot
    [8, 5, 6, 2], // 182 Crystalvein
    [2, 5, 6, 5], // 183 Nightfall
    [3, 4, 8, 7], // 184 Thornweaver
    [7, 7, 5, 2], // 185 Emberclaw
    [2, 7, 5, 5], // 186 Frostfang
    [2, 3, 6, 7], // 187 Ironbark
    [8, 4, 3, 4], // 188 Silverscale
    [7, 6, 2, 7], // 189 Goldmane
    [8, 3, 6, 2], // 190 Bronzewing
    [3, 7, 8, 4], // 191 Coppertail
    [5, 4, 6, 2], // 192 Steelheart
    [3, 2, 5, 7], // 193 Cobaltfin
    [7, 5, 3, 3], // 194 Chromatic
    [8, 5, 2, 5], // 195 Prismatic
    [7, 4, 8, 3], // 196 Opalescent
    [5, 7, 5, 2], // 197 Pearlshine
    [2, 8, 2, 7], // 198 Amethyst
    [6, 2, 7, 3], // 199 Emeraldine
    [6, 4, 5, 3], // 200 Rubythorn
    [4, 3, 4, 7], // 201 Topazglow
    [7, 2, 6, 5], // 202 Garnetflare
    [4, 4, 5, 7], // 203 Obsidian
    [6, 8, 2, 2], // 204 Onyx
    [5, 2, 3, 8], // 205 Turquoise
    [4, 4, 8, 6], // 206 Malachite
    [8, 8, 3, 3], // 207 Lazuli
    [8, 6, 2, 4], // 208 Aquamarine
    [3, 7, 4, 7], // 209 Beryl
    [8, 3, 6, 3], // 210 Zircon
    [2, 2, 6, 7], // 211 Agate
    [2, 7, 2, 6], // 212 Jasper
    [7, 3, 8, 2], // 213 Carnelian
    [4, 7, 5, 3], // 214 Moonstone
    [2, 2, 7, 8], // 215 Sunstone
    [4, 7, 6, 2], // 216 Bloodstone
    [7, 3, 6, 3], // 217 Thunderjaw
    [5, 3, 6, 8], // 218 Stormscale
    [2, 5, 8, 7], // 219 Windwalker
    [7, 3, 2, 5], // 220 Firebrand
    [7, 4, 4, 3], // 221 Iceveil
    [8, 3, 2, 6], // 222 Voidtouched
    [8, 2, 5, 6], // 223 Netherbloom
    [6, 5, 4, 5], // 224 Spiritfang
    [6, 8, 6, 2], // 225 Soulreaver
    [3, 8, 4, 5], // 226 Doomhowl
    [6, 3, 9, 4], // 227 Oblivion
    [4, 9, 9, 4], // 228 Cataclysm
    [8, 9, 3, 3], // 229 Apocalypse
    [7, 3, 4, 9], // 230 Ragnarok
    [6, 4, 9, 4], // 231 Armageddon
    [7, 9, 7, 3], // 232 Leviathan
    [4, 3, 6, 9], // 233 Behemoth
    [6, 8, 4, 4], // 234 Colossus
    [7, 7, 4, 7], // 235 Juggernaut
    [9, 3, 6, 4], // 236 Titan
    [8, 8, 3, 3], // 237 Seraphim
    [9, 9, 4, 5], // 238 Nephilim
    [9, 3, 8, 4], // 239 Archon
    [3, 6, 8, 9], // 240 Sovereign
    [9, 3, 8, 3], // 241 Imperator
    [8, 3, 8, 8], // 242 Nexus
    [4, 9, 4, 7], // 243 Singularity
    [8, 9, 6, 3], // 244 Infinity
    [4, 4, 7, 8], // 245 Eternity
    [6, 7, 8, 3], // 246 Genesis
    [6, 7, 3, 7], // 247 Eclipse
    [6, 5, 8, 4], // 248 Kaleidoscope
    [6, 5, 6, 6], // 249 Twinned
    [3, 6, 7, 8], // 250 Sparkletail
    [7, 6, 5, 6], // 251 Riddler
    [3, 10, 2, 1], // 252 Rosita
    [6, 2, 6, 7], // 253 Brooklet
    [5, 5, 7, 6], // 254 Whisper
    [7, 7, 4, 2], // 255 Misty
    [7, 2, 7, 4], // 256 Lerma
];

pub fn get_card_ranks(card_id: u32) -> [Field; 4] {
    assert((card_id >= 1) & (card_id <= 256), "Invalid card ID for rank lookup");
    CARD_RANKS[card_id - 1]
}

// ====================== TESTS ======================

#[test]
fn test_known_card_ranks() {
    // Spot-checks transcribed by hand from the pre-table if/else implementation.
    assert(get_card_ranks(1) == [1, 4, 1, 5]); // Mudwalker
    assert(get_card_ranks(46) == [3, 10, 2, 1]); // Rosita
    assert(get_card_ranks(137) == [3, 2, 5, 6]); // Basil
    assert(get_card_ranks(230) == [7, 3, 4, 9]); // Ragnarok
    assert(get_card_ranks(256) == [7, 2, 7, 4]); // Lerma
}

#[test]
fn test_all_ranks_in_range() {
    for i in 1..257 {
        let ranks = get_card_ranks(i as u32);
        for j in 0..4 {
            let r = ranks[j] as u32;
            assert((r >= 1) & (r <= 10));
        }
    }
}

#[test(should_fail_with = "Invalid card ID for rank lookup")]
fn test_card_id_zero_rejected() {
    let _ = get_card_ranks(0);
}

#[test(should_fail_with = "Invalid card ID for rank lookup")]
fn test_card_id_257_rejected() {
    let _ = get_card_ranks(257);
}

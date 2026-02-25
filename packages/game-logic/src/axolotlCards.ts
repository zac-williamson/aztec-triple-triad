/**
 * Axolotl Card Database — 256+ unique axolotl-themed cards across 4 rarity tiers.
 *
 * Rarity tiers:
 * - Common (70%):  Basic axolotl varieties. Lower ranks (1-6).
 * - Rare (20%):    Unusual variants — leucistic, melanoid, copper. Moderate ranks (3-8).
 * - Epic (8%):     Exceptional — GFP, chimera, mosaic. Higher ranks (5-9).
 * - Legendary (2%): Mythical/extraordinary. Top ranks (7-10).
 *
 * Card selection from seeds:
 * - Rarity: (card_seed >> 16) % 100 → 0-69 common, 70-89 rare, 90-97 epic, 98-99 legendary
 * - Card index: (card_seed & 0xFFFF) % CARDS_PER_POOL[rarity]
 */

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface AxolotlCard {
  id: number;
  name: string;
  ranks: { top: number; right: number; bottom: number; left: number };
  rarity: Rarity;
}

export const RARITY_TIERS: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

// Helper to create card entries concisely
function c(id: number, name: string, t: number, r: number, b: number, l: number, rarity: Rarity): AxolotlCard {
  return { id, name, ranks: { top: t, right: r, bottom: b, left: l }, rarity };
}

export const AXOLOTL_CARDS: AxolotlCard[] = [
  // ========== COMMON (IDs 1-180) — Basic axolotl varieties ==========
  // Pink axolotls (1-20)
  c(1, 'Rosy Gills', 1, 3, 2, 4, 'common'),
  c(2, 'Pink Pebble', 3, 1, 4, 2, 'common'),
  c(3, 'Blushing Fin', 2, 4, 1, 3, 'common'),
  c(4, 'Coral Wader', 4, 2, 3, 1, 'common'),
  c(5, 'Cherry Gill', 1, 5, 1, 3, 'common'),
  c(6, 'Rosewater', 3, 3, 2, 2, 'common'),
  c(7, 'Petal Float', 5, 1, 2, 2, 'common'),
  c(8, 'Bubblegum', 2, 2, 4, 2, 'common'),
  c(9, 'Salmon Drift', 1, 4, 3, 2, 'common'),
  c(10, 'Blush Creek', 4, 1, 1, 4, 'common'),
  c(11, 'Flamingo Tail', 2, 3, 3, 2, 'common'),
  c(12, 'Peach Fuzz', 3, 2, 1, 4, 'common'),
  c(13, 'Candy Gill', 1, 1, 5, 3, 'common'),
  c(14, 'Rose Quartz', 4, 3, 1, 2, 'common'),
  c(15, 'Pink Mist', 2, 1, 4, 3, 'common'),
  c(16, 'Carnation', 3, 4, 2, 1, 'common'),
  c(17, 'Mauve Ripple', 1, 2, 3, 4, 'common'),
  c(18, 'Berry Splash', 5, 2, 1, 2, 'common'),
  c(19, 'Rosy Dawn', 2, 5, 2, 1, 'common'),
  c(20, 'Tulip Fin', 1, 3, 4, 2, 'common'),
  // Wild-type axolotls (21-40)
  c(21, 'Mudskipper', 3, 2, 3, 2, 'common'),
  c(22, 'Spotted Tail', 2, 4, 2, 2, 'common'),
  c(23, 'Olive Slider', 4, 1, 3, 2, 'common'),
  c(24, 'Bark Pattern', 1, 3, 2, 4, 'common'),
  c(25, 'Fern Walker', 3, 1, 4, 2, 'common'),
  c(26, 'Mossback', 2, 3, 1, 4, 'common'),
  c(27, 'Twig Gills', 4, 2, 2, 2, 'common'),
  c(28, 'Swamp Diver', 1, 4, 3, 2, 'common'),
  c(29, 'Creek Dweller', 2, 2, 5, 1, 'common'),
  c(30, 'Pond Lurker', 5, 1, 1, 3, 'common'),
  c(31, 'Leaf Fin', 1, 5, 2, 2, 'common'),
  c(32, 'Stone Crawler', 3, 3, 1, 3, 'common'),
  c(33, 'Brown Betty', 2, 1, 3, 4, 'common'),
  c(34, 'Mudpup', 4, 2, 1, 3, 'common'),
  c(35, 'Fen Walker', 1, 3, 3, 3, 'common'),
  c(36, 'Pebble Gill', 3, 1, 2, 4, 'common'),
  c(37, 'Brook Tail', 2, 4, 1, 3, 'common'),
  c(38, 'Ditch Hopper', 1, 2, 4, 3, 'common'),
  c(39, 'Root Hugger', 4, 3, 1, 2, 'common'),
  c(40, 'Clay Bed', 3, 2, 2, 3, 'common'),
  // Albino axolotls (41-55)
  c(41, 'Snow Gill', 1, 4, 2, 3, 'common'),
  c(42, 'Ivory Drift', 4, 1, 3, 2, 'common'),
  c(43, 'Ghost White', 2, 3, 4, 1, 'common'),
  c(44, 'Pearl Tail', 3, 2, 1, 4, 'common'),
  c(45, 'Frost Fin', 1, 5, 3, 1, 'common'),
  c(46, 'Milk Drop', 5, 1, 1, 3, 'common'),
  c(47, 'Chalk Walker', 2, 2, 3, 3, 'common'),
  c(48, 'Bone White', 3, 3, 2, 2, 'common'),
  c(49, 'Cotton Gill', 1, 4, 1, 4, 'common'),
  c(50, 'Snowflake', 4, 1, 2, 3, 'common'),
  c(51, 'Moonbeam', 2, 3, 3, 2, 'common'),
  c(52, 'White Whisker', 3, 2, 4, 1, 'common'),
  c(53, 'Dove Tail', 1, 1, 5, 3, 'common'),
  c(54, 'Cloud Float', 5, 2, 1, 2, 'common'),
  c(55, 'Powder Gill', 2, 4, 2, 2, 'common'),
  // Golden axolotls (56-70)
  c(56, 'Sunspot', 3, 1, 3, 3, 'common'),
  c(57, 'Marigold', 1, 3, 4, 2, 'common'),
  c(58, 'Honey Dew', 4, 2, 1, 3, 'common'),
  c(59, 'Amber Gill', 2, 4, 3, 1, 'common'),
  c(60, 'Butterscotch', 3, 3, 2, 2, 'common'),
  c(61, 'Gold Fin', 1, 5, 2, 2, 'common'),
  c(62, 'Citrus Tail', 5, 1, 2, 2, 'common'),
  c(63, 'Canary', 2, 2, 4, 2, 'common'),
  c(64, 'Topaz Drift', 4, 2, 2, 2, 'common'),
  c(65, 'Wheat Walker', 2, 3, 1, 4, 'common'),
  c(66, 'Cornsilk', 3, 1, 4, 2, 'common'),
  c(67, 'Yolk Drop', 1, 4, 3, 2, 'common'),
  c(68, 'Honeycomb', 4, 1, 1, 4, 'common'),
  c(69, 'Dandelion', 2, 2, 3, 3, 'common'),
  c(70, 'Saffron Pup', 3, 3, 1, 3, 'common'),
  // Everyday poses (71-90)
  c(71, 'Napping Newt', 1, 2, 5, 2, 'common'),
  c(72, 'Yawning Gill', 5, 2, 1, 2, 'common'),
  c(73, 'Curious Peek', 2, 5, 2, 1, 'common'),
  c(74, 'Hiding Spot', 1, 1, 4, 4, 'common'),
  c(75, 'Bubble Blower', 4, 1, 2, 3, 'common'),
  c(76, 'Tail Chaser', 2, 3, 3, 2, 'common'),
  c(77, 'Rock Sitter', 3, 2, 2, 3, 'common'),
  c(78, 'Driftwood', 1, 4, 2, 3, 'common'),
  c(79, 'Sand Roller', 4, 1, 3, 2, 'common'),
  c(80, 'Plant Nibbler', 2, 3, 1, 4, 'common'),
  c(81, 'Cave Hugger', 3, 1, 4, 2, 'common'),
  c(82, 'Moss Muncher', 1, 4, 3, 2, 'common'),
  c(83, 'Pebble Pusher', 4, 2, 1, 3, 'common'),
  c(84, 'Worm Hunter', 2, 1, 5, 2, 'common'),
  c(85, 'Snail Chaser', 1, 5, 2, 2, 'common'),
  c(86, 'Algae Drifter', 5, 1, 1, 3, 'common'),
  c(87, 'Stone Hider', 3, 2, 3, 2, 'common'),
  c(88, 'Gentle Float', 2, 3, 2, 3, 'common'),
  c(89, 'Lazy Loafer', 1, 2, 4, 3, 'common'),
  c(90, 'Sun Basker', 4, 3, 1, 2, 'common'),
  // Juvenile stages (91-110)
  c(91, 'Tiny Tadpole', 1, 1, 3, 5, 'common'),
  c(92, 'Wee Wiggler', 5, 1, 1, 3, 'common'),
  c(93, 'Baby Gills', 1, 3, 5, 1, 'common'),
  c(94, 'Little Legs', 3, 5, 1, 1, 'common'),
  c(95, 'Mini Fin', 2, 2, 2, 4, 'common'),
  c(96, 'Sprout Tail', 4, 2, 2, 2, 'common'),
  c(97, 'Fry Float', 2, 4, 2, 2, 'common'),
  c(98, 'Puddle Pup', 2, 2, 4, 2, 'common'),
  c(99, 'Hatchling', 1, 3, 3, 3, 'common'),
  c(100, 'Fledgling Gill', 3, 1, 3, 3, 'common'),
  c(101, 'Nipper', 3, 3, 1, 3, 'common'),
  c(102, 'Squirt', 3, 3, 3, 1, 'common'),
  c(103, 'Wobbler', 1, 4, 1, 4, 'common'),
  c(104, 'Toddler Tail', 4, 1, 4, 1, 'common'),
  c(105, 'Button Eyes', 1, 1, 4, 4, 'common'),
  c(106, 'Gill Bud', 4, 4, 1, 1, 'common'),
  c(107, 'Micro Muncher', 2, 3, 2, 3, 'common'),
  c(108, 'Larval Lad', 3, 2, 3, 2, 'common'),
  c(109, 'Guppy Gill', 2, 1, 3, 4, 'common'),
  c(110, 'Starter Fish', 4, 3, 1, 2, 'common'),
  // Habitat-themed (111-135)
  c(111, 'River Runner', 1, 5, 2, 2, 'common'),
  c(112, 'Lake Lounger', 2, 2, 5, 1, 'common'),
  c(113, 'Canal Crawler', 5, 1, 2, 2, 'common'),
  c(114, 'Reservoir Pup', 2, 2, 1, 5, 'common'),
  c(115, 'Spring Seeker', 1, 3, 4, 2, 'common'),
  c(116, 'Waterfall Wader', 4, 2, 1, 3, 'common'),
  c(117, 'Marsh Mover', 2, 1, 3, 4, 'common'),
  c(118, 'Delta Drifter', 3, 4, 2, 1, 'common'),
  c(119, 'Bay Walker', 1, 2, 4, 3, 'common'),
  c(120, 'Lagoon Lurker', 4, 3, 1, 2, 'common'),
  c(121, 'Estuary Eel', 2, 4, 3, 1, 'common'),
  c(122, 'Tributary Tail', 3, 1, 2, 4, 'common'),
  c(123, 'Rapids Rider', 1, 2, 3, 4, 'common'),
  c(124, 'Oxbow Drifter', 4, 1, 2, 3, 'common'),
  c(125, 'Pool Paddler', 3, 2, 4, 1, 'common'),
  c(126, 'Streamlet', 1, 4, 1, 4, 'common'),
  c(127, 'Brookside', 4, 1, 4, 1, 'common'),
  c(128, 'Creekbed', 2, 3, 2, 3, 'common'),
  c(129, 'Bog Breather', 3, 2, 3, 2, 'common'),
  c(130, 'Puddle Prince', 1, 3, 3, 3, 'common'),
  c(131, 'Dew Dropper', 3, 1, 1, 5, 'common'),
  c(132, 'Rain Catcher', 5, 1, 3, 1, 'common'),
  c(133, 'Flood Friend', 1, 5, 1, 3, 'common'),
  c(134, 'Drizzle Gill', 3, 1, 5, 1, 'common'),
  c(135, 'Splash Pad', 2, 4, 1, 3, 'common'),
  // Seasonal/weather (136-155)
  c(136, 'Spring Sprout', 1, 3, 2, 4, 'common'),
  c(137, 'Summer Sunny', 4, 2, 3, 1, 'common'),
  c(138, 'Autumn Amber', 3, 1, 4, 2, 'common'),
  c(139, 'Winter Chill', 2, 4, 1, 3, 'common'),
  c(140, 'Rainy Day', 1, 2, 5, 2, 'common'),
  c(141, 'Foggy Morning', 5, 2, 1, 2, 'common'),
  c(142, 'Sunny Side', 2, 5, 2, 1, 'common'),
  c(143, 'Cloudy Gill', 1, 1, 3, 5, 'common'),
  c(144, 'Windy Walker', 4, 1, 2, 3, 'common'),
  c(145, 'Thunder Pup', 3, 3, 2, 2, 'common'),
  c(146, 'Hail Fin', 2, 2, 3, 3, 'common'),
  c(147, 'Sleet Slider', 1, 4, 2, 3, 'common'),
  c(148, 'Frost Bite', 3, 2, 4, 1, 'common'),
  c(149, 'Heat Wave', 4, 1, 1, 4, 'common'),
  c(150, 'Cool Breeze', 1, 4, 4, 1, 'common'),
  c(151, 'Dawn Gill', 2, 3, 1, 4, 'common'),
  c(152, 'Dusk Drifter', 4, 1, 3, 2, 'common'),
  c(153, 'Midnight Pup', 1, 2, 4, 3, 'common'),
  c(154, 'Noon Napper', 3, 4, 1, 2, 'common'),
  c(155, 'Twilight Tail', 2, 1, 3, 4, 'common'),
  // Food-themed (156-175)
  c(156, 'Shrimp Snacker', 1, 5, 2, 2, 'common'),
  c(157, 'Worm Gulper', 5, 1, 2, 2, 'common'),
  c(158, 'Pellet Pal', 2, 2, 5, 1, 'common'),
  c(159, 'Brine Eater', 2, 2, 1, 5, 'common'),
  c(160, 'Bug Catcher', 1, 4, 3, 2, 'common'),
  c(161, 'Bloodworm Fan', 4, 2, 1, 3, 'common'),
  c(162, 'Daphnia Lover', 2, 1, 4, 3, 'common'),
  c(163, 'Tubifex Gill', 3, 3, 2, 2, 'common'),
  c(164, 'Nightcrawler', 2, 4, 2, 2, 'common'),
  c(165, 'Cricket Muncher', 4, 2, 2, 2, 'common'),
  c(166, 'Feeder Fish Fan', 2, 2, 2, 4, 'common'),
  c(167, 'Mealworm Gobbler', 1, 3, 3, 3, 'common'),
  c(168, 'Plankton Pup', 3, 1, 3, 3, 'common'),
  c(169, 'Larva Licker', 3, 3, 1, 3, 'common'),
  c(170, 'Snack Time', 3, 3, 3, 1, 'common'),
  c(171, 'Greedy Gill', 1, 1, 5, 3, 'common'),
  c(172, 'Feast Finder', 5, 3, 1, 1, 'common'),
  c(173, 'Crumb Catcher', 1, 5, 1, 3, 'common'),
  c(174, 'Morsel Mouth', 3, 1, 1, 5, 'common'),
  c(175, 'Belly Full', 2, 3, 2, 3, 'common'),
  // Personality-themed (176-180)
  c(176, 'Shy Gill', 1, 2, 4, 3, 'common'),
  c(177, 'Bold Fin', 4, 3, 1, 2, 'common'),
  c(178, 'Sleepy Head', 2, 1, 3, 4, 'common'),
  c(179, 'Playful Pup', 3, 4, 2, 1, 'common'),
  c(180, 'Grumpy Gill', 1, 3, 3, 3, 'common'),

  // ========== RARE (IDs 181-230) — Unusual axolotl variants ==========
  // Leucistic variants (181-195)
  c(181, 'Leucistic Pearl', 4, 5, 3, 5, 'rare'),
  c(182, 'White Spectre', 5, 3, 5, 4, 'rare'),
  c(183, 'Pale Monarch', 3, 6, 4, 4, 'rare'),
  c(184, 'Ghost Gills', 6, 4, 3, 4, 'rare'),
  c(185, 'Translucent Drift', 4, 4, 6, 3, 'rare'),
  c(186, 'Crystal Clear', 3, 5, 4, 5, 'rare'),
  c(187, 'Diamond Frost', 5, 3, 4, 5, 'rare'),
  c(188, 'Silver Wisp', 4, 6, 3, 4, 'rare'),
  c(189, 'Opal Gill', 6, 3, 5, 3, 'rare'),
  c(190, 'Platinum Pup', 3, 5, 5, 4, 'rare'),
  c(191, 'Moonstone', 5, 4, 3, 5, 'rare'),
  c(192, 'Starlight Walker', 4, 3, 6, 4, 'rare'),
  c(193, 'Snow Crystal', 3, 6, 4, 4, 'rare'),
  c(194, 'Ice Veil', 6, 4, 4, 3, 'rare'),
  c(195, 'Frosted Fern', 4, 5, 3, 5, 'rare'),
  // Melanoid variants (196-207)
  c(196, 'Dark Diver', 5, 4, 5, 3, 'rare'),
  c(197, 'Obsidian Gill', 3, 5, 4, 5, 'rare'),
  c(198, 'Shadow Walker', 4, 3, 6, 4, 'rare'),
  c(199, 'Midnight Oil', 6, 5, 3, 3, 'rare'),
  c(200, 'Ink Spot', 3, 4, 5, 5, 'rare'),
  c(201, 'Charcoal Fin', 5, 3, 3, 6, 'rare'),
  c(202, 'Ebony Tail', 4, 6, 4, 3, 'rare'),
  c(203, 'Onyx Pup', 3, 4, 6, 4, 'rare'),
  c(204, 'Jet Stream', 6, 3, 4, 4, 'rare'),
  c(205, 'Sable Drift', 4, 5, 3, 5, 'rare'),
  c(206, 'Coal Crawler', 5, 3, 5, 4, 'rare'),
  c(207, 'Raven Gill', 3, 6, 4, 4, 'rare'),
  // Copper variants (208-218)
  c(208, 'Copper Crown', 5, 5, 3, 4, 'rare'),
  c(209, 'Bronze Belly', 4, 3, 5, 5, 'rare'),
  c(210, 'Russet Tail', 3, 5, 5, 4, 'rare'),
  c(211, 'Penny Bright', 5, 4, 4, 4, 'rare'),
  c(212, 'Tarnished Gill', 4, 4, 3, 6, 'rare'),
  c(213, 'Burnished Fin', 6, 3, 4, 4, 'rare'),
  c(214, 'Copperglow', 4, 5, 5, 3, 'rare'),
  c(215, 'Patina Pup', 3, 4, 6, 4, 'rare'),
  c(216, 'Rust Walker', 5, 6, 3, 3, 'rare'),
  c(217, 'Metallic Drift', 3, 3, 5, 6, 'rare'),
  c(218, 'Oxidized Gill', 6, 4, 3, 4, 'rare'),
  // Piebald/chimera variants (219-230)
  c(219, 'Piebald Prince', 4, 5, 4, 4, 'rare'),
  c(220, 'Patchy Pete', 5, 4, 4, 4, 'rare'),
  c(221, 'Half Moon', 4, 4, 5, 4, 'rare'),
  c(222, 'Split Face', 4, 4, 4, 5, 'rare'),
  c(223, 'Yin Yang', 5, 3, 5, 4, 'rare'),
  c(224, 'Harlequin', 3, 5, 4, 5, 'rare'),
  c(225, 'Domino Gill', 4, 6, 3, 4, 'rare'),
  c(226, 'Calico Drift', 6, 3, 4, 4, 'rare'),
  c(227, 'Mottled Fin', 4, 4, 6, 3, 'rare'),
  c(228, 'Dappled Dawn', 3, 4, 4, 6, 'rare'),
  c(229, 'Speckled Star', 5, 5, 4, 3, 'rare'),
  c(230, 'Freckled Frost', 3, 4, 5, 5, 'rare'),

  // ========== EPIC (IDs 231-250) — Exceptional axolotls ==========
  // GFP (Green Fluorescent Protein) variants
  c(231, 'Neon Glow', 6, 7, 5, 6, 'epic'),
  c(232, 'Radioactive', 7, 5, 6, 6, 'epic'),
  c(233, 'Bioluminescent', 5, 6, 7, 6, 'epic'),
  c(234, 'Green Lantern', 6, 6, 5, 7, 'epic'),
  c(235, 'Phosphor Gill', 7, 6, 6, 5, 'epic'),
  // Chimera/Mosaic patterns
  c(236, 'True Chimera', 6, 5, 7, 6, 'epic'),
  c(237, 'Mosaic Master', 5, 7, 6, 6, 'epic'),
  c(238, 'Split Soul', 7, 6, 5, 6, 'epic'),
  c(239, 'Dual Nature', 6, 6, 7, 5, 'epic'),
  c(240, 'Mirror Half', 5, 6, 6, 7, 'epic'),
  // Special morphs
  c(241, 'Albino Golden', 7, 5, 6, 6, 'epic'),
  c(242, 'Lavender Haze', 6, 7, 5, 6, 'epic'),
  c(243, 'Enigma Pattern', 5, 6, 7, 6, 'epic'),
  c(244, 'Firefly Gill', 6, 6, 6, 6, 'epic'),
  c(245, 'Aurora Borealis', 7, 5, 5, 7, 'epic'),
  c(246, 'Stained Glass', 5, 7, 7, 5, 'epic'),
  c(247, 'Prismatic Fin', 6, 5, 7, 6, 'epic'),
  c(248, 'Iridescent', 7, 6, 5, 6, 'epic'),
  c(249, 'Holographic', 6, 7, 6, 5, 'epic'),
  c(250, 'Plasma Drift', 5, 6, 6, 7, 'epic'),

  // ========== LEGENDARY (IDs 251-258) — Mythical/extraordinary ==========
  c(251, 'Ancient Axolotl', 8, 7, 9, 8, 'legendary'),
  c(252, 'Cosmic Axolotl', 9, 8, 7, 8, 'legendary'),
  c(253, 'Crystal Axolotl', 7, 9, 8, 8, 'legendary'),
  c(254, 'Phoenix Axolotl', 8, 8, 7, 9, 'legendary'),
  c(255, 'Void Axolotl', 9, 7, 8, 8, 'legendary'),
  c(256, 'Ethereal Axolotl', 8, 8, 9, 7, 'legendary'),
  c(257, 'Primordial Axolotl', 7, 8, 8, 9, 'legendary'),
  c(258, 'Celestial Axolotl', 9, 9, 7, 7, 'legendary'),
];

/** Number of cards in each rarity pool: [common, rare, epic, legendary] */
export const CARDS_PER_POOL: [number, number, number, number] = [
  AXOLOTL_CARDS.filter(c => c.rarity === 'common').length,
  AXOLOTL_CARDS.filter(c => c.rarity === 'rare').length,
  AXOLOTL_CARDS.filter(c => c.rarity === 'epic').length,
  AXOLOTL_CARDS.filter(c => c.rarity === 'legendary').length,
];

// Build lookup maps for fast access
const cardByIdMap = new Map<number, AxolotlCard>();
const cardsByRarityMap = new Map<Rarity, AxolotlCard[]>();

for (const card of AXOLOTL_CARDS) {
  cardByIdMap.set(card.id, card);
  const list = cardsByRarityMap.get(card.rarity) ?? [];
  list.push(card);
  cardsByRarityMap.set(card.rarity, list);
}

/** Get a card by its ID. Returns undefined if not found. */
export function getAxolotlCardById(id: number): AxolotlCard | undefined {
  return cardByIdMap.get(id);
}

/** Get all cards of a given rarity. */
export function getAxolotlCardsByRarity(rarity: Rarity): AxolotlCard[] {
  return cardsByRarityMap.get(rarity) ?? [];
}

/**
 * Determine rarity from a rarity roll value (0-99).
 * Matches the circuit logic: (card_seed >> 16) % 100
 *   0-69  → common (70%)
 *   70-89 → rare (20%)
 *   90-97 → epic (8%)
 *   98-99 → legendary (2%)
 */
export function determineRarity(rarityRoll: number): Rarity {
  if (rarityRoll < 70) return 'common';
  if (rarityRoll < 90) return 'rare';
  if (rarityRoll < 98) return 'epic';
  return 'legendary';
}

/**
 * Select a card from the appropriate rarity pool using a card seed.
 * Uses: (card_seed & 0xFFFF) % num_cards_in_pool
 * Returns the selected AxolotlCard or undefined if pool is empty.
 */
export function selectCardFromPool(cardSeed: number, rarity: Rarity): AxolotlCard | undefined {
  const pool = getAxolotlCardsByRarity(rarity);
  if (pool.length === 0) return undefined;
  const index = (cardSeed & 0xFFFF) % pool.length;
  return pool[index];
}

#!/usr/bin/env python3
"""Generate web/market-seed-plan.json from data/item-data.json (EDA catalog).

Rules (see CHANGELOG / operator notes):
- Sell tradeable items + schematics; exclude contracts, cosmetics/customization,
  construction, emotes, mementos, plot/story/"green" items, and unusable set packs.
- Commodities list at stack_max with 2 listings.
- T6 gradeable armor/weapons/stillsuits: stock (q0) + ranks 1-5, 2 each.
- T6 augments: ranks 1-5 only (no rank 0); honor catalog min_quality_level.
- Schematics for those same T6 rankable families: bake grades 1-5 (2 each),
  augments from min_quality_level when set.
- Tools/vehicles/Tier 1-5 gear and their schematics: stock only (quality 0).
- Vehicles/ammo/consumables/fuel/cartography: stock only, 2 listings.
- Durability on listings scales 100..200 by tier and quality grade; seed SQL
  writes that into item stats (orders keep wear 1.0/1.0).
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ITEM_DATA = ROOT / "data" / "item-data.json"
OUT = ROOT / "web" / "market-seed-plan.json"
OLD = OUT  # reuse prior unsafe list when present

PRICE_MULTIPLIER = 5
LISTINGS_PER_GRADE = 2
AUGMENT_TEMPLATE_RE = re.compile(r"^T\d+_Augment_", re.IGNORECASE)
GRADE_MULTIPLIERS = [1.0, 1.0, 1.25, 1.5, 1.75, 2.0]
VENDOR_MULT = {"common": 1.0, "rare": 5.0, "unique": 5.0, "memento": 2.0}
MIN_MEANINGFUL_VENDOR_PRICE = 10

KNOWN_D1 = {"garment": 0, "weapons": 1, "vehicles": 2, "utility": 3, "augment": 4, "misc": 5}
KNOWN_D2 = {
    "lightarmor": 0, "heavyarmor": 1, "stillsuits": 2, "utilitywearables": 3, "socialwearables": 4,
    "pistol": 2, "heavypistol": 3, "heavyrifle": 4, "smg": 5, "spitdart": 6, "shotgun": 7,
    "battlerifle": 8, "heavyshotgun": 9, "missilelauncher": 10, "flamethrower": 11,
    "fireballer": 12, "lasgun": 13, "ammunition": 14,
    "sandbike": 0, "buggy": 1, "lightornithopter": 2, "mediumornithopter": 3,
    "transportornithopter": 4, "sandcrawler": 5,
    "buildingtools": 0, "hydrationtools": 2, "gatheringtools": 3, "cartographytools": 4,
    "utilitytools": 5, "consumables": 6, "deployables": 1,
    "armor": 0, "melee": 1, "ranged": 2, "misc": 3,
    "fuel": 0, "refinedresources": 1, "components": 2, "rawresources": 3,
}
KNOWN_D3 = {"cutteray": 0, "compactor": 1}
DEPTH3_PARENT = {
    ("lightarmor", "head"): 0, ("lightarmor", "chest"): 1, ("lightarmor", "legs"): 2,
    ("lightarmor", "hands"): 3, ("lightarmor", "feet"): 4,
    ("heavyarmor", "head"): 0, ("heavyarmor", "chest"): 1, ("heavyarmor", "legs"): 2,
    ("heavyarmor", "hands"): 3, ("heavyarmor", "feet"): 4,
    ("stillsuits", "head"): 0, ("stillsuits", "chest"): 1, ("stillsuits", "hands"): 2, ("stillsuits", "feet"): 3,
    ("socialwearables", "chest"): 0, ("socialwearables", "legs"): 1,
    ("socialwearables", "hands"): 2, ("socialwearables", "feet"): 3,
    ("sandbike", "chassis"): 0, ("sandbike", "hull"): 1, ("sandbike", "engine"): 2,
    ("sandbike", "psu"): 3, ("sandbike", "locomotion"): 4, ("sandbike", "utility"): 5,
    ("buggy", "chassis"): 0, ("buggy", "hull"): 1, ("buggy", "rear"): 2, ("buggy", "engine"): 3,
    ("buggy", "psu"): 4, ("buggy", "locomotion"): 5, ("buggy", "turret"): 6, ("buggy", "utility"): 7,
    ("lightornithopter", "chassis"): 0, ("lightornithopter", "cockpit"): 1, ("lightornithopter", "hull"): 2,
    ("lightornithopter", "engine"): 3, ("lightornithopter", "psu"): 4, ("lightornithopter", "locomotion"): 5,
    ("lightornithopter", "utility"): 6,
    ("mediumornithopter", "chassis"): 0, ("mediumornithopter", "cabin"): 1, ("mediumornithopter", "cockpit"): 2,
    ("mediumornithopter", "tail"): 3, ("mediumornithopter", "engine"): 4, ("mediumornithopter", "psu"): 5,
    ("mediumornithopter", "locomotion"): 6, ("mediumornithopter", "utility"): 7,
    ("transportornithopter", "chassis"): 0, ("transportornithopter", "hull"): 1,
    ("transportornithopter", "engine"): 2, ("transportornithopter", "psu"): 3,
    ("transportornithopter", "locomotion"): 4, ("transportornithopter", "utility"): 5,
    ("sandcrawler", "chassis"): 0, ("sandcrawler", "cabin"): 1, ("sandcrawler", "engine"): 2,
    ("sandcrawler", "psu"): 3, ("sandcrawler", "locomotion"): 4, ("sandcrawler", "utility"): 5,
    ("hydrationtools", "watertools"): 0, ("hydrationtools", "bloodtools"): 1,
    ("utilitytools", "powerpack"): 0, ("utilitytools", "suspensor"): 1, ("utilitytools", "utility"): 3,
    ("utilitytools", "shield"): 2,
    ("consumables", "utility"): 2,
    ("gatheringtools", "cutteray"): 0, ("gatheringtools", "compactor"): 1,
}
WEAPON_PATH_REMAP = {"shortblades": (0, 0), "longblades": (0, 1)}
UNIQUE_SCHEMATICS_D2 = {"garment": 5, "weapons": 3, "vehicles": 6, "utility": 7, "augment": 4}
UNIQUE_SCHEMATICS_D3 = {
    "lightarmor": 0, "heavyarmor": 1, "stillsuits": 2, "utilitywearables": 3, "socialwearables": 4,
    "shortblades": 0, "longblades": 1, "pistol": 2, "heavypistol": 3, "heavyrifle": 4, "smg": 5,
    "spitdart": 6, "shotgun": 7, "battlerifle": 8, "heavyshotgun": 9, "missilelauncher": 10,
    "flamethrower": 11, "fireballer": 12, "lasgun": 13,
    "sandbike": 0, "buggy": 1, "lightornithopter": 2, "mediumornithopter": 3,
    "transportornithopter": 4, "sandcrawler": 5,
    "deployables": 0, "watertools": 1, "bloodtools": 2, "cutteray": 3, "staticcompactor": 4,
    "cartographytools": 5, "shield": 6, "suspensor": 7, "powerpack": 8,
    "armor": 0, "melee": 1, "ranged": 2, "misc": 3,
}

# Unusable "set pack" style names (cosmetic bundles), not individual Acheronian pieces.
SET_PACK_RE = re.compile(
    r"(?i)(\bset\b.*\bvariant\b|\bvariant\b.*\bset\b|building set|placeables set|"
    r"pilot set customization|armor set variant|sofa and chair set|mural and baliset|"
    r"^\s*.+\s+set\s*$)"
)
STORY_ID_RE = re.compile(r"(?i)(_story_|story_|_memento|memento_|_npc|npc_|ph_|xx_)")
PLACEHOLDER_NAME_RE = re.compile(r"(?i)^(ph_|xx_|n/a\b)|name\s*$")


def round_price(v: int) -> int:
    if v >= 1_000_000:
        step = 100_000
    elif v >= 100_000:
        step = 10_000
    elif v >= 10_000:
        step = 1_000
    elif v >= 1_000:
        step = 100
    else:
        step = 10
    return int(round(v / step) * step)


def equipment_price(tier: int) -> int:
    return {1: 2000, 2: 8000, 3: 30000, 4: 100000, 5: 300000, 6: 750000}.get(tier, 500)


def schematic_equipment_price(tier: int) -> int:
    return {1: 500, 2: 1500, 3: 4000, 4: 12000, 5: 30000, 6: 75000}.get(tier, 500)


def material_unit_price(tier: int) -> int:
    return {1: 20, 2: 80, 3: 200, 4: 600, 5: 1500, 6: 4000}.get(tier, 5)


def rarity_mult(rarity: str) -> float:
    return VENDOR_MULT.get((rarity or "common").lower(), 1.0)


def base_price(entry: dict, is_schematic: bool) -> int:
    vendor = int(entry.get("vendor_price") or 0)
    rarity = (entry.get("rarity") or "common").lower()
    tier = int(entry.get("tier") or 0)
    stack = int(entry.get("stack_max") or 1)
    material_cost = int(entry.get("material_cost") or 0)
    if material_cost > 0 and stack <= 1 and not is_schematic and rarity in ("unique", "memento"):
        schem = schematic_equipment_price(tier) * rarity_mult(rarity)
        return int(round(schem + material_cost * 0.75))
    if vendor >= MIN_MEANINGFUL_VENDOR_PRICE:
        return int(round(vendor * rarity_mult(rarity)))
    if stack <= 1:
        base = schematic_equipment_price(tier) if is_schematic else equipment_price(tier)
        return int(round(base * rarity_mult(rarity)))
    p = int(round(material_unit_price(tier) * rarity_mult(rarity)))
    return max(1, p)


def graded_price(base: int, grade: int) -> int:
    return round_price(int(round(base * GRADE_MULTIPLIERS[grade])))


def listing_price(base: int, grade: int) -> int:
    """Seed plan stores prices at the addon default multiplier."""
    return max(1, round_price(int(round(graded_price(base, grade) * PRICE_MULTIPLIER))))


def durability_for(tier: int, grade: int) -> float:
    """Absolute durability 100..200. Higher tier and quality inflate toward 200."""
    tier = max(0, min(6, int(tier or 0)))
    grade = max(0, min(5, int(grade or 0)))
    tier_base = {0: 100, 1: 100, 2: 110, 3: 125, 4: 145, 5: 165, 6: 180}[tier]
    return float(min(200, tier_base + grade * 4))


def category_mask(category: str, is_unique_schematic: bool) -> tuple[int, int] | None:
    if not category:
        return None
    parts = category.split("/")
    if is_unique_schematic and len(parts) >= 3:
        d1 = parts[1]
        if d1 in UNIQUE_SCHEMATICS_D2:
            d3seg = parts[2]
            d3 = UNIQUE_SCHEMATICS_D3.get(d3seg)
            if d3 is None and len(parts) >= 4:
                d3seg = parts[3]
                d3 = UNIQUE_SCHEMATICS_D3.get(d3seg)
            if d3 is not None:
                mask = (KNOWN_D1[d1] << 24) | (UNIQUE_SCHEMATICS_D2[d1] << 16) | (d3 << 8)
                return mask, 3

    n = min(len(parts), 4)
    if n < 2:
        return None
    depth = n - 1
    if n >= 3 and parts[1] == "weapons" and parts[2] in WEAPON_PATH_REMAP:
        remap = WEAPON_PATH_REMAP[parts[2]]
        mask = (KNOWN_D1["weapons"] << 24) | (remap[0] << 16) | (remap[1] << 8)
        return mask, 3

    mask = 0
    all_found = True
    for i in range(1, n):
        seg = parts[i]
        found = False
        code = 0
        if i == 3 and len(parts) >= 3:
            key = (parts[2], seg)
            if key in DEPTH3_PARENT:
                code, found = DEPTH3_PARENT[key], True
        if not found:
            table = KNOWN_D1 if i == 1 else KNOWN_D2 if i == 2 else KNOWN_D3
            if i == 1:
                table = KNOWN_D1
            elif i == 2:
                table = KNOWN_D2
            else:
                table = KNOWN_D3
            if seg in table:
                code, found = table[seg], True
        if not found:
            all_found = False
        mask |= code << ((4 - i) * 8)
    if not all_found:
        return None
    return mask, depth


def kind_for(category: str, is_schematic: bool) -> str:
    if is_schematic:
        return "schematic"
    if "/ammunition" in category:
        return "ammunition"
    if "/consumables" in category:
        return "consumable"
    if "/cartographytools" in category:
        return "cartography"
    if any(x in category for x in ("/rawresources", "/refinedresources", "/components", "/fuel")):
        return "resource"
    if category.startswith("items/utility/"):
        return "utility"
    return "equippable"


def is_rankable_category(category: str) -> bool:
    """Armor/weapons/stillsuits/augments — the only families that use quality ranks."""
    return any(
        category.startswith(p)
        for p in (
            "items/garment/lightarmor",
            "items/garment/heavyarmor",
            "items/garment/stillsuits",
            "items/weapons/",
            "items/augment/",
        )
    )


def is_augment(template_id: str, category: str) -> bool:
    """Augments, matched the way RedBlink Console matches them.

    Console's `isStandaloneAugmentTemplate` (console/api/src/duneDb.js) accepts
    the augment catalog plus the `T<n>_Augment_` id pattern, and its
    `normalizeStandaloneAugmentQuality` lifts anything below rank 1 up to 1.
    """
    return category.startswith("items/augment/") or bool(AUGMENT_TEMPLATE_RE.match(template_id))


def should_exclude(tid: str, entry: dict) -> str | None:
    if entry.get("tradeable") is False:
        return "non-tradeable"
    category = entry.get("category") or ""
    if not category:
        return "no-category"
    if category.startswith("items/customization/") or category.startswith("items/construction/"):
        return "customization/construction"
    name = entry.get("name") or ""
    rarity = (entry.get("rarity") or "").lower()
    tier = int(entry.get("tier") or 0)
    # Uniques stock through T6 only (Dunewatcher-class); nothing above T6.
    if rarity == "unique" and tier > 6:
        return "unique-above-t6"
    if rarity == "memento":
        return "memento"
    if tid.startswith("Emote_") or "/emote" in category.lower() or "emote" in category.lower():
        return "emote"
    if "contract" in category.lower() or "contract" in name.lower():
        return "contract"
    if STORY_ID_RE.search(tid) or PLACEHOLDER_NAME_RE.search(name):
        return "plot/placeholder"
    # Unusable set packs / cosmetic set variants. Individual named pieces
    # (Acheronian Boots, etc.) do not match this.
    if SET_PACK_RE.search(name) and "armor" not in category and "garment" not in category:
        return "set-pack"
    if re.search(r"(?i)set customization|set variant|building set|placeables set", name):
        return "set-pack"
    if re.search(r"(?i)^\s*.+\s+set\s*$", name) and kind_for(category, bool(entry.get("is_schematic"))) not in (
        "equippable",
        "schematic",
        "utility",
    ):
        return "set-pack"
    # Social clothes: not requested for the market.
    if "/socialwearables" in category:
        return "social"
    return None


def grades_for(template_id: str, entry: dict, category: str, is_schematic: bool) -> list[int]:
    """Quality levels to seed.

    Only catalog-gradeable T6 armor/weapons/stillsuits/augments (and their
    schematics) get ranks. Tools (sand compactors, cutterays, …), vehicles,
    and all Tier 1–5 gear stay at quality 0 — previously every schematic was
    forced through grades 1–5, which showed up in-game as Rank 1–5 on items
    that do not have ranks.

    Augments have no rank 0 at all: they start at rank 1 (or the catalog
    min_quality_level when higher) through 5. Console enforces the same floor
    when it grants augments, so a rank-0 augment listing would be a state the
    game itself never produces.
    """
    tier = int(entry.get("tier") or 0)
    gradeable = bool(entry.get("is_gradeable"))
    stack = max(1, int(entry.get("stack_max") or 1))
    min_q = int(entry.get("min_quality_level") or 0)
    if min_q < 0 or min_q > 5:
        min_q = 0

    if is_augment(template_id, category):
        start = max(1, min_q)
        # A non-gradeable augment has one real rank, not a 1-5 ladder, but it
        # still cannot be rank 0.
        return list(range(start, 6)) if gradeable else [start]

    if stack > 1 or not gradeable or tier < 6 or not is_rankable_category(category):
        return [0]
    if is_schematic:
        return list(range(max(1, min_q), 6))
    # Armor/weapons/stillsuits: stock (q0) plus ranks 1–5.
    return list(range(min_q, 6))


def main() -> None:
    data = json.loads(ITEM_DATA.read_text())
    items: dict = data["items"]

    old_unsafe: list[str] = []
    if OLD.exists():
        try:
            old_unsafe = list(json.loads(OLD.read_text()).get("unsafe_template_ids") or [])
        except Exception:
            old_unsafe = []

    excluded: Counter[str] = Counter()
    skipped_mask = 0
    rows: list[dict] = []

    for tid, entry in sorted(items.items(), key=lambda kv: (kv[1].get("name") or kv[0], kv[0])):
        reason = should_exclude(tid, entry)
        if reason:
            excluded[reason] += 1
            continue

        is_schematic = bool(entry.get("is_schematic"))
        category = entry["category"]
        rarity = (entry.get("rarity") or "common").lower()
        tier = int(entry.get("tier") or 0)
        stack = max(1, int(entry.get("stack_max") or 1))
        kind = kind_for(category, is_schematic)

        is_unique_schematic = is_schematic and rarity in ("unique", "memento")
        mask_depth = category_mask(category, is_unique_schematic)
        if mask_depth is None:
            # Fall back to non-unique encoding for unique schematics with unknown subtype.
            mask_depth = category_mask(category, False)
        if mask_depth is None:
            skipped_mask += 1
            continue
        mask, depth = mask_depth

        base = base_price(entry, is_schematic)
        for grade in grades_for(tid, entry, category, is_schematic):
            dur = durability_for(tier, grade)
            rows.append(
                {
                    "template_id": tid,
                    "display_name": entry.get("name") or tid,
                    "kind": kind,
                    "stack_size": stack,
                    "price": listing_price(base, grade),
                    "category_mask": mask,
                    "category_depth": depth,
                    "quality_level": grade,
                    "special_boost": False,
                    "listings": LISTINGS_PER_GRADE,
                    "durability_cur": dur,
                    "durability_max": dur,
                    "tier": tier,
                    "rarity": rarity or "common",
                }
            )

    # Preserve prior unsafe drop list, plus anything still non-tradeable / story.
    unsafe = set(old_unsafe)
    for tid, entry in items.items():
        if entry.get("tradeable") is False or STORY_ID_RE.search(tid) or (entry.get("rarity") or "").lower() == "memento":
            unsafe.add(tid)

    summary = {
        "listings": sum(r["listings"] for r in rows),
        "unique_rows": len(rows),
        "unique_templates": len({r["template_id"] for r in rows}),
        "price_multiplier": PRICE_MULTIPLIER,
        "listings_per_grade": LISTINGS_PER_GRADE,
    }
    for kind in ("equippable", "schematic", "resource", "ammunition", "consumable", "utility", "cartography"):
        summary[f"{kind}_listings"] = sum(r["listings"] for r in rows if r["kind"] == kind)
    summary["resource_units"] = sum(
        r["stack_size"] * r["listings"] for r in rows if r["kind"] == "resource"
    )

    category_counts = Counter(f"{r['category_mask']} / depth {r['category_depth']}" for r in rows)

    # Drop helper fields not used by the addon runtime from published rows.
    published = []
    for r in rows:
        published.append(
            {
                "template_id": r["template_id"],
                "display_name": r["display_name"],
                "kind": r["kind"],
                "stack_size": r["stack_size"],
                "price": r["price"],
                "category_mask": r["category_mask"],
                "category_depth": r["category_depth"],
                "quality_level": r["quality_level"],
                "special_boost": False,
                "listings": r["listings"],
                "durability_cur": r["durability_cur"],
                "durability_max": r["durability_max"],
            }
        )

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "panel_version": "0.12.0",
        "price_multiplier": PRICE_MULTIPLIER,
        "market_bot_class": "Revy",
        "summary": summary,
        "category_counts": [{"category": k, "listings": v} for k, v in category_counts.most_common()],
        "rows": published,
        "notes": [
            "Generated from Easy Dune Admin item-data.json via scripts/generate-seed-plan.py.",
            "Schematic grades 1-5 only for T6 rankable armor/weapons/stillsuits/augments; tools and Tier 1-5 stay quality 0.",
            "T6 rankable armor/weapons/stillsuits seed stock (q0) plus ranks 1-5; augments seed ranks 1-5 only (honor min_quality_level; no rank 0).",
            "Commodities use stack_max from the catalog. Absolute durability 100-200 by tier/grade is stored on plan rows for item stats seeding; exchange order wear stays 1.0/1.0.",
            "Excluded: non-tradeable, contracts, customization/construction, emotes, mementos, plot/story items, social wearables, unusable set packs.",
            "Write actions run through RedBlink's permissioned database:write addon bridge.",
        ],
        "unsafe_template_ids": sorted(unsafe),
        "generation": {
            "excluded": dict(excluded),
            "skipped_unknown_category_mask": skipped_mask,
            "source": "data/item-data.json",
        },
    }

    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {OUT} with {len(published)} rows, {summary['listings']} listings")
    print("Excluded:", dict(excluded))
    print("Skipped mask:", skipped_mask)
    print("Kinds:", Counter(r["kind"] for r in published))
    print("Quality levels:", Counter(r["quality_level"] for r in published))


if __name__ == "__main__":
    main()

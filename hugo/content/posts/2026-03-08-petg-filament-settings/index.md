---
title: "PETG Filament Settings: Why the Advertised Temperatures Are Wrong"
date: 2026-03-08T20:00:00-06:00
draft: false
author: "zolty"
description: "Dialing in PETG settings on the Bambu Lab P1S -- running 265C nozzle and 80C bed instead of the advertised 230-250C, why first layer temps matter, and how Amazon delivered 4KG of filament just before I ran out."
tags: ["3d-printing", "petg", "filament", "bambu-lab", "homelab"]
categories: ["Infrastructure"]
cover:
  image: "/images/covers/infrastructure.svg"
  alt: "PETG filament temperature settings"
  hidden: false
ShowToc: true
TocOpen: false
---

## TL;DR

PETG is the go-to filament for functional homelab parts — heat resistant, mechanically strong, and chemically stable. The advertised temperature ranges on most PETG spools (230-250C nozzle) are too low. After systematic testing, the settings that actually produce strong, well-bonded prints on the {{< amzn search="Bambu Lab P1S 3D Printer" >}}Bambu Lab P1S{{< /amzn >}} are 265C nozzle and 80C bed, with first layer at 270C/85C. These temperatures are 15-35C hotter than what the manufacturer label suggests. Amazon came through with a {{< amzn search="PETG filament 4KG bulk" >}}4KG bulk delivery{{< /amzn >}} that arrived the same day the previous spool ran out, which was cutting it closer than I would like.

## Why PETG for Homelab Parts

PLA is the default 3D printing material, but it has a critical weakness for homelab use: heat.

| Property | PLA | PETG |
|----------|-----|------|
| **Glass Transition** | ~60C | ~80C |
| **Heat Resistance** | Poor — deforms near electronics | Good — stable next to running hardware |
| **Layer Adhesion** | Good | Excellent |
| **Flexibility** | Brittle — snaps | Slight flex — bends before breaking |
| **UV Resistance** | Poor | Good |
| **Chemical Resistance** | Degrades with IPA | Stable with IPA |
| **Ease of Printing** | Easy | Moderate |
| **Stringing** | Minimal | More (manageable) |

The homelab environment is hostile to PLA. The M920q nodes run at 40-60C surface temperature. The rack area ambient can hit 30C+ in summer. Parts near the UPS and power strips see elevated temperatures constantly.

I found this out the hard way. PLA cable management clips near the back of an M920q started sagging after a few weeks. One clip drooped directly into the airflow path. A ventilation grille near the exhaust vent warped enough to no longer sit flat.

PETG solved this completely. Parts printed months ago still look and fit exactly as designed, even pressed directly against running hardware. The slight flexibility is also an advantage — PETG bends before breaking, so snap-fit clips survive repeated install/remove cycles where PLA versions cracked on the third attempt.

## The Amazon 4KG Save

I was in the middle of printing a batch of cable management clips and a new revision of the node enclosure when I noticed the spool was getting light. Picked it up — maybe 50 grams left, which is barely enough for the clips, never mind the enclosure.

I had already ordered a 4KG bulk pack of PETG from Amazon a few days earlier. Checked the tracking: "arriving today." The printer was actively consuming the last of the old spool.

The timing ended up being closer than I would have preferred. The old spool ran out mid-print — the P1S detected it via the filament runout sensor, paused the print, and sent a notification to my phone. The Amazon delivery had arrived about an hour earlier. I loaded the new filament, hit resume, and the print continued where it left off. Zero waste, zero failed print, zero downtime.

The 4KG bulk buy is the right move for homelab use. Individual 1KG spools run $20-25 each at retail. The 4KG pack works out to significantly less per kilogram. At the rate I am printing homelab parts — a spool every 2-3 weeks — the savings add up fast.

The lesson: order filament before you need it. The "I will order it when the spool gets low" approach nearly cost me a multi-hour print and a wasted partial enclosure.

## Temperature Settings That Actually Work

Here are the settings that produce strong, reliable PETG prints on the P1S:

| Parameter | Advertised Range | My Setting | Delta |
|-----------|-----------------|------------|-------|
| **Nozzle Temperature** | 230-250C | 265C | +15-35C |
| **Bed Temperature** | 70-80C | 80C | +0-10C |
| **First Layer Nozzle** | (same as above) | 270C | +5C over printing temp |
| **First Layer Bed** | (same as above) | 85C | +5C over printing temp |

At 230-240C, PETG technically prints. The layers bond visually and the part looks fine. But mechanically, it is weak — you can snap a part along layer lines with moderate hand pressure.

At 265C, the difference is dramatic. Layer adhesion is strong enough that parts break through the infill pattern rather than at layer boundaries. The material itself fails before the layer bond does. For homelab brackets that bear load or snap onto hardware, this is the difference between a functional part and a fragile one.

I tested this systematically by printing a set of test bars at 5C increments from 230C to 270C. Clamped one end in a vise and pushed on the other until they broke. The 260-270C range was consistently 2-3x stronger than the 230-240C range. Every bar below 250C snapped cleanly along a layer line. Every bar above 260C broke irregularly through the infill.

Stringing is slightly worse at 265C than at 240C. The trade is worth it every time. Stringing is cosmetic — a quick pass with a heat gun cleans it up in seconds. Weak layer adhesion is a structural failure.

## First Layer: The 5-Degree Bump

The first layer is the most critical part of any print. If it does not stick, the print fails.

Running the first layer 5 degrees hotter on both nozzle (270C) and bed (85C) makes a noticeable difference in adhesion. The hotter nozzle temperature makes the PETG flow more freely as it is deposited, allowing it to spread into the build plate texture and grip. After the first layer, the extra temperature is unnecessary and slightly increases stringing risk, so dropping back to 265C for the remaining layers is the right balance.

The 85C bed on the first layer softens the PETG contact point slightly as it is being deposited, creating a stronger mechanical bond between the filament and the plate. After the first layer, the bed drops to 80C — enough to keep the part adhered but not so hot that it causes elephant's foot, where the first layer squishes outward under the weight of subsequent layers.

Bambu Studio makes this easy to configure. The first-layer temperature offset is a dedicated setting in the filament profile, not something you need to hack into G-code manually.

{{< ad >}}

## Why the Advertised Temps Are Wrong

The label on the filament spool says 230-250C. Why does 265C work better?

The advertised range is the safe range — temperatures where PETG will print without issues on practically any printer, including open-frame machines without heated enclosures, older printers with poor temperature control, and printers with PTFE-lined hotends.

PTFE-lined hotends are common in budget printers, and PTFE starts degrading above 240C. Manufacturers set their recommended range to avoid damaging hotend components on lower-end hardware. The P1S uses an all-metal hotend rated well above 300C. There is no PTFE to worry about.

The enclosed chamber also changes the equation. On an open-frame printer, the part cools aggressively because ambient air convects heat away from every layer as it is printed. Higher nozzle temperatures partly compensate for that heat loss, but you are fighting the environment. Inside the P1S enclosure, the chamber stabilizes at 35-45C during a print. The temperature differential between freshly deposited filament and the cooling part is more consistent, reducing thermal stress and improving interlayer bonding.

There is also a materials science reason. PETG has a glass transition temperature around 80C and a crystalline melt point around 260C. Printing at 230-240C means the material is only partially molten — it flows enough to extrude, but the polymer chains do not have sufficient mobility to fully entangle across layer boundaries. At 265C, the polymer is well above the melt point, chains diffuse freely across the layer interface, and the result is a weld rather than a seam.

The right temperature is the one that produces the best parts for your specific printer, enclosure, and filament. Do not trust the label. Print test bars and break them.

## Print Settings Beyond Temperature

Temperature is the biggest lever, but other settings matter for PETG:

- **Print speed**: 60-80mm/s for outer walls, 100-150mm/s for infill. Slightly slower than PLA because PETG is more viscous and needs time to wet out against the previous layer.
- **Retraction**: 0.8-1.0mm on the P1S direct drive extruder. Too much retraction with PETG causes heat-creep clogs because the material is sticky and can jam in the heat break. Longer retractions are a Bowden-tube technique that does not translate to direct drive.
- **Cooling**: Part cooling fan at 30-50%, not the 100% you would run for PLA. Active cooling helps with overhangs but hurts layer adhesion. On the P1S, the auxiliary fan at 30% is a good balance.
- **Infill**: 40% gyroid for functional parts (brackets, mounts) that bear load. 15-20% grid for enclosures and covers that just need to hold shape. PETG's stronger layer adhesion means you can run lower infill than PLA for equivalent strength.
- **Build plate**: Use a {{< amzn search="Bambu Lab smooth PEI plate" >}}smooth PEI plate{{< /amzn >}} for PETG. The textured PEI plate bonds too aggressively to PETG and can tear the coating when you try to remove the part. The smooth plate provides strong adhesion at 80C and releases cleanly once the bed cools.
- **Filament drying**: PETG is hygroscopic — it absorbs moisture from the air. Wet filament produces bubbling, popping sounds during extrusion, and rough surface finish. If print quality degrades suddenly after the spool has been open for a week, the filament needs drying, not a settings change. Store open spools in a dry box or use a {{< amzn search="SUNLU filament dryer" >}}filament dryer{{< /amzn >}} before printing.

## Results: Homelab Parts in PETG

Every functional part in the homelab is now printed with these exact settings:

- **Node enclosures**: 4-hour print, ~120g PETG per enclosure, 0.2mm layer height. Zero warping or deformation after months of use next to running M920q hardware. As covered in the [P1S post](/posts/2026-03-06-bambu-lab-p1s-3d-printing/), the hexagonal mesh ventilation pattern actually improved thermals over the open-air stack.
- **SFP+ cable brackets**: 25-minute print, ~8g PETG. Snap-fit clip that holds firmly and survives repeated removal without cracking.
- **Cable management clips**: batch of 20 in a single print job, 1.5 hours total. Custom-sized to the specific cable bundles in the rack.
- **Ventilation grilles**: hex mesh patterns placed directly against exhaust vents. PETG heat resistance means they do not soften even in the direct airflow from running hardware.

Dimensional accuracy across these parts: +/- 0.15mm on average. Slightly less precise than PLA (PETG has more thermal expansion during cooling) but well within tolerance for snap-fit and press-fit applications.

## Lessons Learned

1. **Ignore the temperature on the filament label.** The advertised 230-250C is a safe minimum for lowest-common-denominator printers. On an enclosed printer with an all-metal hotend, 265C nozzle and 80C bed produces dramatically stronger parts.
2. **First layer gets 5 degrees extra.** 270C nozzle, 85C bed for the first layer, then drop to 265C/80C. The hotter first layer ensures adhesion without compromising quality on subsequent layers.
3. **Order filament in bulk before you need it.** A 4KG Amazon order buys weeks of buffer. Running out mid-print is a real risk when you are printing homelab parts regularly. The per-kilogram savings on bulk are substantial.
4. **Stringing is a cosmetic issue, not a structural one.** Accept slightly more stringing at higher temperatures in exchange for significantly stronger layer adhesion. A heat gun cleans up strings in seconds.
5. **Dry your filament.** PETG absorbs moisture fast. If print quality suddenly degrades — popping sounds, rough surfaces, excessive stringing — the filament needs drying, not a settings change.
6. **Test mechanically, not just visually.** A print can look perfect at 240C and be structurally weak. Print test bars and try to break them. The difference between 240C and 265C is invisible to the eye but obvious when you put force on it.

"""
pipeline/extract.py

Core extraction logic: Wikidata entity JSON → OurStory DB schema dict.

Pure functions — no I/O, no network calls, no GCP dependencies.
Works identically in run_local.py (plain Python) and run_spark.py (PySpark
mapPartitions). Import this module from both.
"""

from typing import Optional

# ---------------------------------------------------------------------------
# Category mapping: Wikidata P31 QID → OurStory category string
#
# Keys are Wikidata Q-IDs for instance-of values.
# Values are OurStory category names matching frontend/src/types/index.ts.
# None means "generic type — needs LLM category assignment".
# ---------------------------------------------------------------------------

WIKIDATA_TO_CATEGORY: dict[str, Optional[str]] = {
    # Battle / Military engagement
    "Q178561":  "battle",        # battle
    "Q188055":  "battle",        # skirmish
    "Q831663":  "battle",        # naval battle
    "Q348120":  "battle",        # amphibious warfare
    "Q3817498": "battle",        # last stand
    "Q1361229": "battle",        # conquest
    "Q188055":  "battle",        # siege

    # War / Armed conflict (broader than a single battle)
    "Q198":     "war",           # war
    "Q8465":    "war",           # civil war
    "Q467011":  "war",           # invasion
    "Q1348385": "war",           # war of succession
    "Q3119121": "war",           # revolutionary war
    "Q4688003": "war",           # aerial bombing of a city
    "Q135010":  "war",           # war crime
    "Q645883":  "war",           # military operation
    "Q1261499": "battle",        # naval battle (specific battle type)
    "Q45382":   "politics",      # coup d'état (alt QID)

    # Politics
    "Q40231":   "politics",      # election
    "Q131569":  "politics",      # international treaty
    "Q49773":   "politics",      # summit meeting
    "Q1781513": "politics",      # coup d'état
    "Q167466":  "politics",      # assassination
    "Q3882219": "politics",      # assassination (alt)
    "Q10931":   "politics",      # revolution (political)
    "Q124734":  "politics",      # rebellion
    "Q1139665": "politics",      # political murder
    "Q930164":  "politics",      # conspiracy
    "Q6813020": "politics",      # stabbing attack
    "Q191797":  "politics",      # riot
    "Q2334719": "politics",      # political crisis
    "Q145694":  "politics",      # abdication
    "Q3839261": "politics",      # political trial
    "Q208251":  "politics",      # declaration of independence

    # Disaster (natural or human-caused)
    "Q124490":  "disaster",      # natural disaster
    "Q7944":    "disaster",      # earthquake
    "Q8092":    "disaster",      # flood
    "Q7692360": "disaster",      # volcanic eruption (Q8928 is 'constellation')
    "Q3839081": "disaster",      # wildfire
    "Q2635894": "disaster",      # epidemic
    "Q3241045": "disaster",      # disease outbreak
    "Q44512":   "disaster",      # epidemic (alt SPARQL class)
    "Q12184":   "disaster",      # pandemic
    "Q2723958": "disaster",      # influenza epidemic
    "Q838718":  "disaster",      # city fire
    "Q2656967": "disaster",      # nuclear explosion
    "Q1931234": "disaster",      # industrial disaster
    "Q3071558": "disaster",      # famine
    "Q168247":  "disaster",      # famine (alt)
    "Q3199915": "war",           # massacre

    # Religion
    "Q2085381": "religion",      # religious event
    "Q3464753": "religion",      # religious persecution
    "Q8441":    "religion",      # crusade
    "Q82821":   "religion",      # council (ecclesiastical)
    "Q186431":  "religion",      # conclave
    "Q29102902":"religion",      # papal election

    # Founding / Establishment
    "Q1473346": "founding",      # founding of a city
    "Q2334788": "founding",      # declaration of independence

    # Discovery / Exploration
    "Q43229":   "discovery",     # discovery
    "Q2678658": "discovery",     # scientific discovery
    "Q2685356": "exploration",   # exploration
    "Q43702":   "exploration",   # expedition
    "Q170584":  "exploration",   # expedition (alt)
    "Q2401485": "exploration",   # expedition (SPARQL class)
    "Q366301":  "exploration",   # scientific expedition
    "Q1198916": "exploration",   # voyage of discovery

    # Science & Technology
    "Q11862829":"science",       # scientific experiment
    "Q752783":  "science",       # human spaceflight
    "Q4026292": "science",       # invention
    "Q2678658": "science",       # scientific discovery

    # Science & Discovery (additional classes)
    "Q1318295": "science",       # astronomical discovery (planet/comet/asteroid finds)
    "Q42471":   "discovery",     # archaeological discovery (Rosetta Stone, Pompeii, etc.)

    # Politics (additional classes)
    "Q175482":  "politics",      # protest / demonstration
    "Q133311":  "politics",      # strike action (labor strike)
    "Q900792":  "politics",      # referendum / plebiscite
    "Q625994":  "politics",      # international conference / congress
    "Q1765828": "politics",      # inauguration
    "Q5004978": "politics",      # annexation

    # Religion (additional classes)
    "Q45469":   "religion",      # canonization
    "Q191760":  "religion",      # beatification
    "Q30523":   "religion",      # schism
    "Q625017":  "religion",      # religious persecution
    "Q213363":  "religion",      # pilgrimage

    # Culture
    "Q959583":  "culture",       # cultural event
    "Q1784537": "culture",       # art movement
    "Q464980":  "culture",       # art exhibition (Royal Academy, Paris Salon, etc.)
    "Q188686":  "culture",       # world's fair / international exposition
    "Q5389":    "culture",       # Olympic Games (ancient + modern)

    # Known false positives — override to None so LLM handles them properly
    "Q180548":   None,           # Neolithic Revolution — prehistoric process, not political

    # Auto-learned from LLM (do not edit by hand — re-run fix-empty-categories.py)
    "Q191503":  "battle",      # duel
    "Q19841484":  "battle",      # sack
    "Q2001676":  "battle",      # offensive
    "Q646740":  "battle",      # landing operation
    "Q678146":  "battle",      # bombardment
    "Q876274":  "battle",      # naval warfare
    "Q997267":  "battle",      # skirmish
    "Q1006311":  "war",      # war of national liberation
    "Q104212151":  "war",      # series of wars
    "Q107706":  "war",      # armistice
    "Q1155622":  "war",      # slave rebellion
    "Q1323212":  "war",      # insurgency
    "Q13427116":  "war",      # peasant revolt
    "Q1371150":  "war",      # hostage taking
    "Q1384277":  "war",      # military expedition
    "Q16533779":  "war",      # asonada
    "Q217901":  "war",      # capitulation
    "Q21994376":  "war",      # war of independence
    "Q350604":  "war",      # armed conflict
    "Q41397":  "war",      # genocide
    "Q511866":  "war",      # mutiny
    "Q750215":  "war",      # mass murder
    "Q766875":  "war",      # ethnic conflict
    "Q1057954":  "politics",      # by-election
    "Q1078001":  "politics",      # territorial dispute
    "Q112727382":  "politics",      # United States Senate election in Delaware
    "Q112727401":  "politics",      # United States Senate election in Massachusetts
    "Q112727412":  "politics",      # United States Senate election in New York
    "Q112727420":  "politics",      # United States Senate election in Pennsylvania
    "Q124757":  "politics",      # riot
    "Q1464916":  "politics",      # declaration of independence
    "Q15261477":  "politics",      # gubernatorial election
    "Q15283424":  "politics",      # United Kingdom general election
    "Q1570656":  "politics",      # United States midterm election
    "Q15974864":  "politics",      # Spanish general election
    "Q192909":  "politics",      # scandal
    "Q213541":  "politics",      # concordat
    "Q2223653":  "politics",      # terrorist attack
    "Q24333627":  "politics",      # United States Senate election
    "Q24397514":  "politics",      # United States House of Representatives election
    "Q25906438":  "politics",      # attempted coup d'état
    "Q26252880":  "politics",      # United States general election
    "Q26466721":  "politics",      # special election to the United States House of Representativ
    "Q27962800":  "politics",      # United States presidential election in New York
    "Q28206753":  "politics",      # United States presidential election in New Jersey
    "Q28221942":  "politics",      # United States presidential election in Connecticut
    "Q28221947":  "politics",      # United States presidential election in Delaware
    "Q28222030":  "politics",      # United States presidential election in Massachusetts
    "Q28222117":  "politics",      # United States presidential election in Pennsylvania
    "Q28222130":  "politics",      # United States presidential election in South Carolina
    "Q28222160":  "politics",      # United States presidential election in Vermont
    "Q3587148":  "politics",      # French legislative election
    "Q47566":  "politics",      # United States presidential election
    "Q5465517":  "politics",      # food riot
    "Q5791104":  "politics",      # international crisis
    "Q625298":  "politics",      # peace treaty
    "Q686984":  "politics",      # civil disorder
    "Q832107":  "politics",      # Imperial election
    "Q9557810":  "politics",      # bilateral treaty
    "Q989265":  "politics",      # embargo
    "Q114380":  "disaster",      # financial crisis
    "Q168983":  "disaster",      # conflagration
    "Q2165983":  "disaster",      # stampede
    "Q2547976":  "disaster",      # North Atlantic tropical cyclone
    "Q3510594":  "disaster",      # earthquake in Japan
    "Q806729":  "disaster",      # banking crisis
    "Q11514315":  None,          # historical period — generic/excluded
    "Q125360958":  None,          # aspect of women's history — generic/excluded
    "Q13226383":  None,          # facility — generic/excluded
    "Q132821":  None,          # murder — generic/excluded
    "Q17544377":  None,          # history of a country or state — generic/excluded
    "Q180684":  None,          # conflict — generic/excluded
    "Q189349":  None,          # urban legend — generic/excluded
    "Q189819":  None,          # ritual — generic/excluded
    "Q190084":  None,          # hoax — generic/excluded
    "Q4671286":  None,          # academic major — generic/excluded
    "Q52997136":  None,          # Slavic bypass rite — generic/excluded
    "Q6428674":  None,          # era — generic/excluded
    "Q806824":  None,          # bank robbery — generic/excluded
    "Q81672":  None,          # attempted murder — generic/excluded
    "Q816829":  None,          # periodization — generic/excluded
    "Q931092":  None,          # practical joke — generic/excluded

    # Auto-learned from LLM (do not edit by hand — re-run fix-empty-categories.py)
    "Q554211":  "politics",      # State of the Union address
    "Q262478":  "culture",      # Paris Salon
    "Q667276":  "culture",      # art exhibition
    "Q108691705":  None,          # century common year — generic/excluded
    "Q11835767":  None,          # Sejm ekstraordynaryjny — generic/excluded
    "Q15238777":  None,          # legislative term — generic/excluded
    "Q17524420":  None,          # aspect of history — generic/excluded
    "Q18340514":  None,          # events in a specific year or time period — generic/excluded
    "Q186081":  None,          # time interval — generic/excluded
    "Q186117":  None,          # timeline — generic/excluded
    "Q186516":  None,          # national flag — generic/excluded
    "Q19828":  None,          # leap year — generic/excluded
    "Q21094819":  None,          # parliamentary term in the United Kingdom — generic/excluded
    "Q217036":  None,          # leap year starting on Friday and ending on Saturday — generic/excluded
    "Q217041":  None,          # leap year starting on Sunday and ending on Monday — generic/excluded
    "Q235670":  None,          # common year starting and ending on Sunday — generic/excluded
    "Q235673":  None,          # common year starting and ending on Saturday — generic/excluded
    "Q235676":  None,          # common year starting and ending on Wednesday — generic/excluded
    "Q235680":  None,          # common year starting and ending on Friday — generic/excluded
    "Q235684":  None,          # common year starting and ending on Tuesday — generic/excluded
    "Q235687":  None,          # common year starting and ending on Monday — generic/excluded
    "Q235690":  None,          # common year starting and ending on Thursday — generic/excluded
    "Q24706":  None,          # Japanese era name — generic/excluded
    "Q26887310":  None,          # association football team season — generic/excluded
    "Q27020041":  None,          # sports season — generic/excluded
    "Q30715568":  None,          # political era of the United States — generic/excluded
    "Q3186692":  None,          # calendar year — generic/excluded
    "Q37002670":  None,          # unicameral legislature — generic/excluded
    "Q39911":  None,          # decade — generic/excluded
    "Q4948446":  None,          # golden jubilee — generic/excluded
    "Q578":  None,          # century — generic/excluded
    "Q7755":  None,          # constitution — generic/excluded
    "Q9334976":  None,          #  — generic/excluded

    # Auto-learned from LLM (do not edit by hand — re-run fix-empty-categories.py)
    "Q27653727":  "battle",      # naval bombing of a city
    "Q1168287":  "war",      # intervention
    "Q1227249":  "politics",      # international incident
    "Q177716":  "politics",      # pogrom
    "Q1900755":  "politics",      # constituent assembly
    "Q208383":  "politics",      # ceasefire
    "Q22276038":  "politics",      # Norwegian parliamentary election
    "Q2618461":  "politics",      # legislative election
    "Q26878762":  "politics",      # United States presidential election in Indiana
    "Q28221902":  "politics",      # United States presidential election in Alabama
    "Q28222012":  "politics",      # United States presidential election in Louisiana
    "Q28222073":  "politics",      # United States presidential election in New Hampshire
    "Q28222099":  "politics",      # United States presidential election in Ohio
    "Q7157512":  "politics",      # peace conference
    "Q7893160":  "politics",      # United States presidential election in Missouri
    "Q7897387":  "politics",      # unrest
    "Q113549847":  "disaster",      # non-water flood
    "Q327541":  "disaster",      # arson
    "Q629257":  "disaster",      # work accident
    "Q68800046":  "disaster",      # industrial disaster
    "Q8065":  "disaster",      # natural disaster
    "Q8068":  "disaster",      # flood
    "Q389581":  "culture",      # triennale
    "Q59861107":  "culture",      # temporary art exhibition
    "Q1812889":  None,          # legislative session — generic/excluded
    "Q1983893":  None,          # immigration to Canada — generic/excluded
    "Q217015":  None,          # leap year starting on Wednesday and ending on Thursday — generic/excluded
    "Q217024":  None,          # leap year starting on Monday and ending on Tuesday — generic/excluded
    "Q217026":  None,          # leap year starting on Saturday and ending on Sunday — generic/excluded

    # Generic fallbacks — needs LLM category assignment
    "Q13418847": None,           # historical event (generic)
    "Q1190554":  None,           # occurrence (generic)
    "Q3249551":  None,           # process (very generic)
}


# ---------------------------------------------------------------------------
# Claim extraction helpers
# ---------------------------------------------------------------------------

def get_claim_value(claims: dict, prop: str):
    """Returns the first 'value' snak datavalue for a property, or None."""
    for stmt in claims.get(prop, []):
        snak = stmt.get("mainsnak", {})
        if snak.get("snaktype") == "value":
            return snak["datavalue"]["value"]
    return None


def get_all_claim_values(claims: dict, prop: str) -> list:
    """Returns all 'value' snak datavalues for a property."""
    result = []
    for stmt in claims.get(prop, []):
        snak = stmt.get("mainsnak", {})
        if snak.get("snaktype") == "value":
            result.append(snak["datavalue"]["value"])
    return result


def get_item_id(claims: dict, prop: str) -> Optional[str]:
    """Returns the QID string for an item-valued property."""
    val = get_claim_value(claims, prop)
    if val and isinstance(val, dict):
        return val.get("id")
    return None


def get_coord(claims: dict) -> tuple[Optional[float], Optional[float]]:
    """Returns (lat, lon) from P625 (coordinate location), or (None, None)."""
    val = get_claim_value(claims, "P625")
    if val and isinstance(val, dict):
        return val.get("latitude"), val.get("longitude")
    return None, None


def get_time_value(claims: dict, prop: str) -> tuple[Optional[str], int]:
    """Returns (time_str, precision) from a time-valued property."""
    val = get_claim_value(claims, prop)
    if val and isinstance(val, dict) and "time" in val:
        return val["time"], val.get("precision", 9)
    return None, 9


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

def parse_wikidata_time(
    time_str: str, precision: int
) -> tuple[Optional[int], Optional[int], Optional[int], bool]:
    """
    Parses a Wikidata time string into (year, month, day, is_fuzzy).

    Wikidata format: +1066-10-14T00:00:00Z  (CE)
                     -0480-00-00T00:00:00Z  (BCE, astronomical year = -480)
    Precision codes: 11=day, 10=month, 9=year, 8=decade, 7=century, 6=millennium
    is_fuzzy = True when precision < 9 (i.e. we only know decade/century/etc.)
    month/day are None when precision is too coarse or the value is 00 in the source.

    Uses astronomical year numbering:
      - year 1 BCE = -1, year 2 BCE = -2 (consistent with integer arithmetic)
      - year 0 does not exist historically but is used here for 1 BCE in some sources
    """
    if not time_str:
        return None, None, None, True

    is_negative = time_str.startswith("-")
    date_part = time_str.lstrip("+-").split("T")[0]
    parts = date_part.split("-")
    year_str = parts[0]

    try:
        year = int(year_str)
    except ValueError:
        return None, None, None, True

    if is_negative:
        year = -year

    month: Optional[int] = None
    day: Optional[int] = None

    if precision >= 10 and len(parts) > 1:
        m = int(parts[1])
        if m != 0:
            month = m
    if precision >= 11 and len(parts) > 2:
        d = int(parts[2])
        if d != 0:
            day = d

    return year, month, day, (precision < 9)


# ---------------------------------------------------------------------------
# Category mapping
# ---------------------------------------------------------------------------

def map_categories(p31_qids: list[str]) -> tuple[list[str], bool]:
    """
    Maps a list of Wikidata P31 (instance-of) QIDs → OurStory category strings.

    Returns:
        categories  - sorted list of matched category strings
        needs_llm   - True if any QID mapped to None (generic type needs LLM)
    """
    categories: set[str] = set()
    needs_llm = False

    for qid in p31_qids:
        if qid in WIKIDATA_TO_CATEGORY:
            cat = WIKIDATA_TO_CATEGORY[qid]
            if cat is not None:
                categories.add(cat)
            else:
                needs_llm = True
        else:
            needs_llm = True  # unknown P31 type — send to LLM

    return sorted(categories), needs_llm


# ---------------------------------------------------------------------------
# Location P31 classifier sets
#
# Used by both run_local.py (build_location_records) and
# cleanup-non-settlements.py to classify P276/P17 location entities.
# ---------------------------------------------------------------------------

# Settlements — if any of these P31 QIDs is present, classify as 'city'
_CITY_P31: set[str] = {
    "Q515",       # city
    "Q1549591",   # big city
    "Q3957",      # town
    "Q532",       # village
    "Q486972",    # human settlement
    "Q1093829",   # city in the United States
    "Q7930989",   # city/town
    "Q15284",     # municipality
    "Q5119",      # capital city
    "Q200250",    # metropolis
    "Q747074",    # commune of France
    "Q2989398",   # city with millions of inhabitants
    "Q1523821",   # independent city
    "Q21208848",  # city of Germany
    "Q3769014",   # historical settlement
    "Q1489239",   # urban agglomeration
    "Q1637706",   # million city
    "Q174844",    # megacity
    "Q5770918",   # city of Argentina (and similar country-specific types)
    "Q15661340",  # ancient city
    "Q1131296",   # freguesia of Portugal
    "Q1094397",   # autonomous city (treat as city, not country)
    "Q148837",    # polis (ancient Greek city-state)
    "Q2264924",   # port city
    "Q108178728", # national capital
    "Q494721",    # city of Japan
    "Q1749269",   # city designated by government ordinance (Japan)
    "Q65589340",  # prefectural capital of Japan
    "Q13539802",  # place with town rights and privileges
    "Q677678",    # fortified town
    "Q1852859",   # cadastral populated place in the Netherlands
    "Q15303838",  # municipality seat
    # Country-specific municipality / commune / town types
    "Q484170",    # commune of France
    "Q2074737",   # municipality of Spain
    "Q42744322",  # urban municipality in Germany
    "Q116457956", # municipality without town privileges in Germany
    "Q3558970",   # village of Poland
    "Q15127012",  # town in the United States
    "Q5153359",   # municipality of the Czech Republic
    "Q3199141",   # city of Indonesia
    "Q19943591",  # Kotapraja (Indonesian city)
    "Q33146843",  # municipality of Catalonia
    "Q1134686",   # frazione (Italian hamlet)
    "Q493522",    # municipality of Belgium
    "Q667509",    # municipality of Austria
    "Q755707",    # municipality of Norway
    "Q57058",     # municipality of Croatia
    "Q640364",    # municipality of Romania
    "Q659103",    # commune of Romania
    "Q56557504",  # city of Iran
    "Q13217644",  # municipality of Portugal
    "Q1952852",   # municipality of Mexico
    "Q2590631",   # municipality of Hungary
    "Q3184121",   # municipality of Brazil
    "Q2276925",   # municipality of Galicia
    "Q768307",    # municipality of Albania
    "Q741821",    # municipality of East Timor
    "Q203300",    # municipality of Liechtenstein
    "Q646793",    # municipality of North Macedonia
    "Q41067667",  # municipality of Tunisia
    "Q1872284",   # municipality of Guatemala
    "Q2555896",   # municipality of Colombia
    "Q783930",    # municipalities and cities of Serbia
    "Q17268368",  # municipality of Federation of Bosnia and Herzegovina
    "Q6784672",   # municipality of Slovakia
    "Q2039348",   # municipality of the Netherlands
    "Q17343829",  # unincorporated community in the United States
    "Q498162",    # census-designated place in the United States
    "Q2154459",   # New England town
    "Q21672098",  # village of Ukraine
    "Q12131624",  # city in Ukraine
    "Q15078955",  # urban-type settlement in Russia
    "Q2514025",   # posyolok (Russian settlement)
    "Q4845841",   # settlement in Croatia
    "Q56436498",  # village in India
    "Q1529096",   # village of Turkey
    "Q130212458", # village of Kazakhstan
    "Q29946056",  # highly urbanized city (Philippines)
    "Q29029",     # commune (generic)
    "Q5084",      # hamlet
    "Q192601",    # oppidum (ancient settlement)
    "Q763590",    # vicus (ancient Roman settlement)
    "Q22674925",  # former settlement
    # Q19953632 removed — "former administrative territorial entity" is too broad;
    # it matches historical states (Congress Poland, Old Swiss Confederacy), not just settlements
    "Q161387",    # kibbutz
    "Q771444",    # aul (Central Asian village)
    "Q748331",    # stanitsa (Russian Cossack village)
    "Q251749",    # pueblo
    "Q676050",    # old town
    "Q2202509",   # Roman city
    "Q192287",    # administrative divisions of Russia (settlement context)
    "Q3257686",   # locality
}

# Sub-national administrative / geographic regions — classify as 'region'
_REGION_P31: set[str] = {
    "Q35657",    # U.S. state
    "Q107390",   # federal subject of Russia
    "Q860290",   # province of Japan
    "Q82794",    # region
    "Q1299635",  # geographic region
    "Q10864048", # first-level administrative country subdivision
    "Q1620908",  # historical region
    "Q11774891", # historical and geographical region
    "Q209495",   # historical province of France
    "Q16110",    # region of Italy
    "Q158683",   # province of Afghanistan
    "Q162620",   # province of Spain
    "Q2013",     # département of France
    "Q13414763", # county of Pennsylvania (treated as region)
    "Q13415368", # county of Virginia
    "Q13221722", # county of Virginia (alt)
    "Q679103",   # county of a US state (generic)
    "Q11774097", # county of Texas
    "Q13414953", # county in Texas (alt)
    "Q28575",    # county of the United States
    "Q1187811",  # military theater
    "Q3502482",  # cultural region
    "Q36784",    # region of France
    "Q835714",   # oblast of Russia
    "Q485258",   # federative unit of Brazil
    "Q43263",    # federal subject of Russia (alt)
    "Q205495",   # geographic region of England
    "Q18663891", # geographic region of the United States
    "Q7275",     # state (polity) — sub-national
    "Q137186904",# transcontinental region
    # Ancient / historical administrative divisions
    "Q182547",   # Roman province (Q182547 — verified QID)
    "Q1127126",  # province of the Roman Empire (alt)
    "Q166462",   # province (generic administrative division)
    "Q24764",    # prefecture (historical/administrative)
    "Q170412",   # satrapy
    "Q1289426",  # nome (ancient Egyptian province)
    "Q1520223",  # governorate
    "Q871405",   # ancient region
    "Q15042012", # historical administrative division
    "Q15091377", # administrative territorial entity of ancient Rome
    "Q1402592",  # island group (archipelagos that are sub-national)
    "Q33837",    # archipelago
    "Q46395",    # British overseas territory
    "Q1351282",  # crown colony
    "Q10742",    # autonomous community of Spain
    "Q1710033",  # autonomous region with special statute (e.g. Sardinia)
    "Q782614",   # autonomous region
    "Q57362",    # autonomous region of China
    "Q34876",    # province (generic)
    "Q149621",   # district (generic)
    "Q4835091",  # territory (generic)
    "Q379817",   # theme of the Byzantine Empire
    "Q15649510", # satrapy of the Sasanian Empire
    "Q1615742",  # province of China
    "Q12443800", # state of India
    "Q17315624", # state of Myanmar
    "Q501094",   # state of Venezuela
    "Q465842",   # state of Nigeria
    "Q5852411",  # state of Australia
    "Q15063586", # state of Malaysia
    "Q15149663", # state of Mexico
    "Q517351",   # governorate of Syria
    "Q841753",   # governorate of Iraq
    "Q331130",   # governorate of Yemen
    "Q66661665", # governorate of Saudi Arabia
    "Q241753",   # governorate (generic)
    "Q5098",     # province of Indonesia
    "Q3191695",  # regency of Indonesia
    "Q12479773", # first-level administrative subdivision of Indonesia
    "Q12479774", # second-level administrative subdivision of Indonesia
    "Q329028",   # province of Angola
    "Q695469",   # province of Mozambique
    "Q654140",   # province of the DRC
    "Q3110808",  # province of Ethiopia
    "Q191093",   # province of South Africa
    "Q48336",    # province of Turkey
    "Q134390",   # province of the Netherlands
    "Q9319988",  # province of Taiwan
    "Q15058985", # province of Pakistan
    "Q44753",    # province of Argentina
    "Q509686",   # province of Peru
    "Q719987",   # province of Ecuador
    "Q17259945", # province of the Spanish Empire
    "Q574299",   # provinces of Prussia
    "Q216712",   # region of New Zealand
    "Q3775649",  # subregion of Portugal
    "Q2068214",  # district of Mozambique
    "Q2179958",  # district of Peru
    "Q1149652",  # district of India
    "Q1065118",  # district of China
    "Q17143371", # county of South Korea
    "Q18534049", # county of North Korea
    "Q496825",   # district of Afghanistan
    "Q2379075",  # district of Pakistan
    "Q1994931",  # district of Malaysia
    "Q1841634",  # district of Rwanda
    "Q1147395",  # district of Turkey
    "Q56059",    # department of Uruguay
    "Q5260575",  # department of Peru
    "Q815068",   # department of Paraguay
    "Q194203",   # arrondissement of France
    "Q753113",   # region of Brazil
    "Q24698",    # region of the Philippines
    "Q207520",   # region of Japan
    "Q193512",   # region of Finland
    "Q853697",   # historical province of Finland
    "Q1328578",  # region of Turkey
    "Q15072454", # region of Myanmar
    "Q28070554", # region of Sudan
    "Q27535996", # region of Nigeria
    "Q1057504",  # region of Ethiopia
    "Q1137691",  # region of Somaliland
    "Q193556",   # province of Sweden
    "Q742615",   # lands of Sweden
    "Q23058",    # canton of Switzerland
    "Q180673",   # ceremonial county of England
    "Q1350181",  # shire of Scotland
    "Q21457810", # Scottish district
    "Q15979307", # principal area of Wales
    "Q67376938", # historic county of the United Kingdom
    "Q788046",   # autonomous soviet socialist republic
    "Q236036",   # republic of the Soviet Union
    "Q21479969", # British protectorate
    "Q15239622", # disputed territory
    "Q161243",   # dependent territory
    "Q1336152",  # princely state
    "Q10711424", # state with limited recognition
    "Q734818",   # condominium
    "Q23037160", # quasi-state
    "Q98129123", # federal member state of Somalia
    "Q1352230",  # territory of the United States
    "Q123615496",# U.S. region
    "Q66724388", # autonomous country within the Kingdom of Denmark
    "Q185086",   # Crown Dependencies
    "Q4996207",  # bailiwick
    "Q196068",   # lordship
    "Q353344",   # countship
    "Q7695",     # march (border region)
    "Q154547",   # duchy
    "Q16034119", # despotate
    "Q3932025",  # Hellenistic kingdom
    "Q2561694",  # City-kingdom of Cyprus
    "Q671370",   # general governorate of the Russian Empire
    "Q26830017", # state in the Holy Roman Empire (includes free cities like Strasbourg)
}


# Sovereign / empire-level entities — classify as 'country'
_COUNTRY_P31: set[str] = {
    "Q6256",     # country
    "Q3624078",  # sovereign state
    "Q3024240",  # historical country
    "Q417175",   # kingdom (historical)
    "Q20203507", # viceroyalty
    "Q12356456", # viceroyalty (alt)
    "Q15893266", # former entity (generic)
    "Q1790360",  # colonial empire
    "Q48349",    # empire
    "Q133156",   # colony
    "Q5036886",  # captaincy of the Spanish Empire
    "Q99541706", # historical unrecognized state
    "Q21512251", # self-proclaimed state
    "Q18669740", # South African bantustan
    "Q50068795", # historical Chinese state
    "Q170156",   # confederation
    "Q1335818",  # supranational union
    "Q4120211",  # regional organization
    "Q120121699",# political economic union
    "Q2577883",  # occupied territory
    # Q26830017 moved to _REGION_P31 — HRE states include free cities (Strasbourg) not just countries
    "Q188800",   # personal union
    "Q7270",     # republic
    "Q179164",   # unitary state
    "Q1055035",  # grand duchy
    "Q93288",    # duchy
    "Q208838",   # principality
    "Q166280",   # caliphate
    "Q1520009",  # khanate
    "Q12097",    # sultanate
    "Q208011",   # tribal confederacy
    "Q112099",   # island country (e.g. Maldives)
    "Q1088391",  # rump state
    "Q19953632", # former administrative territorial entity (states, not settlements)
    # Q133442 (city-state) intentionally omitted: too broad — Wikidata applies it to
    # many historical cities (Berlin, Hamburg, Vienna, Tyre). City-states hit _CITY_P31
    # via Q515/Q486972 instead.
}

# Pure geographic features — exclude entirely (no location record, no pin)
_EXCLUDE_P31: set[str] = {
    "Q4022",     # river
    "Q23397",    # lake
    "Q8502",     # mountain
    "Q9430",     # ocean
    "Q165",      # sea
    "Q4421",     # forest
    "Q5107",     # continent
    "Q133056",   # mountain pass
    "Q160091",   # plain
    "Q54050",    # hill
    "Q185113",   # cape
    "Q13424466", # natural harbor
    "Q3327333",  # bay
    "Q39594",    # bay (alt)
    "Q12280",    # bridge
    "Q537127",   # road bridge
    "Q18449828", # stone arch bridge
    "Q674541",   # low mountain range (Q674541 plan says Q674541)
    "Q23442",    # island
    "Q34763",    # peninsula
    "Q7930",     # pass (general)
    "Q187223",   # lagoon
    "Q4895508",  # battlefield
    "Q1081138",  # historic site
    "Q1184840",  # historic district
    "Q570116",   # tourist attraction
    "Q1496967",  # landform
    "Q618123",   # geographical object
    "Q12766313", # geographical feature
    "Q2221906",  # geographic location
    "Q283202",   # harbor
    "Q1378975",  # convention center
    "Q1763828",  # multi-purpose hall
    # Water bodies
    "Q1973404",  # adjacent sea
    "Q166620",   # drainage basin
    "Q46831",    # marginal sea
    "Q3792278",  # inland sea
    # Subcontinents / landmasses
    "Q855697",   # subcontinent
    "Q5107",     # continent (already present but listing for clarity)
    # Plazas, squares, and built structures that aren't settlements
    "Q174782",   # square (plaza/town square)
    "Q1507536",  # square (alt)
    # Administrative list articles / meta-entities
    "Q55177041", # list of regions of the PRC (and similar list articles)
    "Q13406463", # list article
    "Q11753321", # list of administrative divisions
    # Palaces, castles, forts
    "Q16560",    # palace
    "Q53536964", # royal palace
    "Q15848826", # city palace
    "Q2651004",  # Palazzo
    "Q83400038", # palace of the Popes
    "Q23413",    # castle
    "Q1785071",  # fort
    "Q481289",   # official residence
    # Streets and roads
    "Q79007",    # street
    # Water passages
    "Q37901",    # strait
    "Q204894",   # marginal sea
    "Q2578218",  # inland sea
    # Volcanoes (geographic features, distinct from Q7692360 volcanic eruption event)
    "Q8072",     # volcano
    "Q169358",   # stratovolcano
    "Q1200524",  # complex volcano
    "Q1161185",  # volcanic island
    "Q159954",   # caldera
    # Buildings — transport
    "Q55488",    # railway station
    "Q4663385",  # former railway station
    # Buildings — incarceration
    "Q40357",    # prison
    "Q1070290",  # prisoner-of-war camp
    "Q708586",   # Stalag
    # Buildings — religious
    "Q16970",    # church building
    "Q1088552",  # Catholic church building
    "Q2713379",  # papal basilica
    "Q124936",   # major basilica
    "Q317557",   # parish church
    "Q334383",   # abbey church
    "Q120560",   # minor basilica
    "Q1370598",  # structure of worship
    "Q2742167",  # religious community
    # Buildings — cultural / civic
    "Q33506",    # museum
    "Q27686",    # hotel
    "Q7138926",  # parliament building
    "Q2519340",  # administrative building
    "Q41176",    # building (generic)
    "Q19860854", # destroyed building or structure
    # Landscapes / terrain (non-administrative)
    "Q75520",    # plateau
    "Q115346835",# temperate steppe
    "Q6617741",  # WWF ecoregion
    "Q107425",   # landscape
    "Q878223",   # highland
    "Q168891",   # cultural geography (ecoregion type)
    "Q39816",    # valley
    "Q2490191",  # river valley
    "Q45776",    # fjord
    "Q150784",   # canyon
    "Q43197",    # river delta
    "Q573344",   # main stem (river)
    "Q47521",    # stream
    "Q3073652",  # coastal river
    "Q1322134",  # gulf
    "Q1544071",  # narrows
    "Q554394",   # ria
    "Q946033",   # polje (karst field)
    "Q192810",   # graben
    "Q1681353",  # bog
    "Q1092661",  # moorland
    "Q8514",     # desert
    "Q332614",   # supervolcano
    "Q13426043", # volcanic arc
    "Q35666",    # glacier
    "Q11762356", # valley glacier
    "Q1065592",  # uninhabited island
    "Q162602",   # river island
    "Q1664473",  # chain of islands
    "Q1140140",  # mainland
    # Transport infrastructure
    "Q644371",   # international airport
    "Q94993988", # commercial traffic aerodrome
    "Q1248784",  # airport
    "Q34442",    # road
    "Q15212722", # national road
    # Borders and boundaries
    "Q15104814", # land boundary
    "Q12413618", # international border
    "Q3089219",  # maritime boundary
    "Q133346",   # border (generic)
    "Q41691",    # demilitarized zone
    # Parks and protected areas
    "Q22698",    # park
    "Q473972",   # protected area
    # Other non-settlement structures
    "Q39614",    # cemetery
    "Q483110",   # stadium
    "Q16917",    # hospital
    "Q875538",   # public university
    "Q38723",    # higher education institution
    "Q24354",    # theatre building
    "Q12516",    # pyramid
    "Q1456099",  # step pyramid
    "Q44539",    # temple
    "Q2977",     # cathedral
    "Q2672772",  # military museum
    "Q91122",    # bunker
    "Q389959",   # air-raid shelter
    "Q1686959",  # underground infrastructure system
    "Q622499",   # refugee camp
    "Q190928",   # shipyard
    "Q2583015",  # ghetto in Nazi-occupied Europe
    "Q124571059",# Palestinian refugee camp
    "Q146924",   # Roman limes (border fortification)
    "Q731966",   # nymphaeum (ornamental fountain/building)
}


def is_known_p31(qid: str) -> bool:
    """Returns True if qid is in any of the hardcoded classifier sets."""
    return (
        qid in _CITY_P31
        or qid in _REGION_P31
        or qid in _COUNTRY_P31
        or qid in _EXCLUDE_P31
    )


# ---------------------------------------------------------------------------
# Polity P31 classifier sets
#
# Used by run_polities.py to classify sovereign political entities.
# Separate from the location classifier — polities are a distinct layer.
# Tier 1: hardcoded canonical QIDs for each polity type (root classes only).
# Tier 2: transitive BFS via classify_p31s_transitive() for unknown P31 QIDs.
# ---------------------------------------------------------------------------

_POLITY_EMPIRE: set[str] = {
    "Q48349",     # empire
    "Q1790360",   # colonial empire
}

_POLITY_KINGDOM: set[str] = {
    "Q417175",    # historical kingdom
    "Q1250464",   # realm
    "Q128193315", # atabegate
}

_POLITY_PRINCIPALITY: set[str] = {
    "Q208500",    # principality
    "Q154547",    # duchy
    "Q1336152",   # princely state (Indian states, etc.)
    "Q26830017",  # state in the Holy Roman Empire
    "Q26879769",  # state in the Confederation of the Rhine
    "Q57318",     # free imperial city
    "Q353344",    # countship
    "Q196068",    # lordship
    "Q1371288",   # vassal state
    "Q463742",    # Hochstift (ecclesiastical principality in HRE)
    # Ottoman / Islamic sub-state administrative units
    "Q1462047",   # vilayet
    "Q44565",     # eyalet
    "Q330425",    # sanjak
    "Q1993723",   # administrative territorial entity of the Ottoman Empire
    "Q113388921", # privileged Ottoman province
}

_POLITY_REPUBLIC: set[str] = {
    "Q7270",      # republic
    "Q472538",    # sister republic (French Revolutionary client states)
}

_POLITY_CONFEDERATION: set[str] = {
    "Q170156",    # confederation
}

_POLITY_SULTANATE: set[str] = {
    "Q12759805",  # sultanate
    "Q331644",    # khanate
    "Q189898",    # emirate
    "Q131401",    # caliphate
}

_POLITY_PAPACY: set[str] = {
    "Q12799209",  # pontificate
}

_POLITY_PEOPLE: set[str] = {
    "Q41710",    # ethnic group
    "Q1345055",  # horde
    "Q133311",   # tribe (human social group)
    "Q1642488",  # chiefdom
    "Q179062",   # chiefdom (duplicate resolution)
    "Q131596",   # indigenous people
    "Q215628",   # people (ethnic)
    "Q271445",   # band society
    "Q4358176",  # indigenous nation
    "Q484736",   # First Nation (Canada)
    "Q1137806",  # Native American tribe
}

_POLITY_COLONY: set[str] = {
    "Q133156",    # colony
    "Q164142",    # protectorate
    "Q12356456",  # viceroyalty
    "Q5036886",   # captaincy general
    "Q1351282",   # crown colony
    "Q185441",    # dependency
}

# P31 values that unambiguously indicate a non-polity entity.
# If ANY of these QIDs is present in p31_qids AND no legitimate polity P31 is
# present, the entity should be excluded from the polities table.
_POLITY_EXCLUDE_P31: set[str] = {
    # Geographic / physical features
    "Q82794",     # region (generic)
    "Q1620908",   # historical region
    "Q518261",    # cultural area
    "Q41710",     # ethnic group
    "Q57450823",  # ethnographic region
    "Q1149061",   # language area
    "Q33837",     # archipelago
    "Q4421",      # forest
    # Infrastructure / plans / documents
    "Q34442",     # road
    "Q1716124",   # national road
    "Q13405588",  # long-distance trail
    "Q16000417",  # National Trail
    "Q118493267", # roundtrip hiking trail
    "Q6672512",   # Great Trail
    "Q663867",    # hiking trail
    "Q69502391",  # bus rapid transit route
    "Q89021600",  # B road
    "Q19753333",  # nuclear weapons program
    "Q855055",    # five-year plans of China
    "Q1619846",   # plan (general plan document)
    "Q2751586",   # resolution
    "Q1363963",   # marketing strategy
    "Q135903355", # takeover defense tactic
    "Q329547",    # motion of no confidence
    "Q182274",    # irredentism
}

_ALL_POLITY_P31: set[str] = (
    _POLITY_EMPIRE | _POLITY_KINGDOM | _POLITY_PRINCIPALITY | _POLITY_REPUBLIC
    | _POLITY_CONFEDERATION | _POLITY_SULTANATE | _POLITY_PAPACY | _POLITY_PEOPLE
    | _POLITY_COLONY
)


def is_known_polity_p31(qid: str) -> bool:
    """Returns True if qid is in any hardcoded polity P31 classifier set."""
    return qid in _ALL_POLITY_P31


def is_known_polity_p31_any(p31_qids: list[str]) -> bool:
    """Returns True if ANY qid in the list is a known polity P31."""
    return any(q in _ALL_POLITY_P31 for q in p31_qids)


def should_exclude_polity(p31_qids: list[str]) -> bool:
    """
    Returns True if the entity should be excluded from the polities table.

    Excludes if ANY p31 is in _POLITY_EXCLUDE_P31 AND no p31 is in any
    legitimate polity set (i.e. the entity is not also a real polity).
    """
    has_bad = any(q in _POLITY_EXCLUDE_P31 for q in p31_qids)
    if not has_bad:
        return False
    has_good = any(q in _ALL_POLITY_P31 for q in p31_qids)
    return not has_good


def classify_polity_type(
    p31_qids: list[str],
    extra_map: Optional[dict[str, Optional[str]]] = None,
    name: Optional[str] = None,
) -> str:
    """
    Classifies a Wikidata polity entity by its P31 (instance-of) QIDs.

    Returns one of: 'papacy' | 'sultanate' | 'confederation' | 'republic'
                  | 'empire' | 'kingdom' | 'principality' | 'other'

    Two-tier strategy (mirrors classify_location):
      Tier 1 — hardcoded canonical QID sets checked in priority order.
      Tier 2 — extra_map from transitive P279* BFS for unknown P31 QIDs.

    extra_map values must be one of the polity type strings or None.
    """
    # Tier 1 — hardcoded sets, checked highest-priority first
    for qid in p31_qids:
        if qid in _POLITY_PAPACY:        return "papacy"
    for qid in p31_qids:
        if qid in _POLITY_SULTANATE:     return "sultanate"
    for qid in p31_qids:
        if qid in _POLITY_CONFEDERATION: return "confederation"
    for qid in p31_qids:
        if qid in _POLITY_REPUBLIC:      return "republic"
    for qid in p31_qids:
        if qid in _POLITY_EMPIRE:        return "empire"
    for qid in p31_qids:
        if qid in _POLITY_KINGDOM:       return "kingdom"
    for qid in p31_qids:
        if qid in _POLITY_PRINCIPALITY:  return "principality"
    for qid in p31_qids:
        if qid in _POLITY_COLONY:        return "colony"
    for qid in p31_qids:
        if qid in _POLITY_PEOPLE:        return "people"

    # Tier 2 — transitive BFS results
    if extra_map:
        _PRIORITY: dict[str, int] = {
            "papacy": 7, "sultanate": 6, "confederation": 5,
            "republic": 4, "empire": 3, "kingdom": 2, "principality": 1,
        }
        best: Optional[str] = None
        for qid in p31_qids:
            t = extra_map.get(qid)
            if t and (best is None or _PRIORITY.get(t, 0) > _PRIORITY.get(best, 0)):
                best = t
        if best:
            return best

    # Tier 3 — name-based fallback for entities with only generic P31s like
    # Q3024240 (historical country) or Q3624078 (sovereign state)
    if name:
        return classify_polity_type_from_name(name)
    return "other"


def classify_polity_type_from_name(name: str) -> str:
    """
    Tier-3 name-based polity type inference. Used when P31 classifier returns
    'other' but the entity name clearly indicates the type.

    Returns the inferred type, or 'other' if name doesn't match any pattern.
    """
    if not name:
        return "other"
    n = name.lower()

    # Papacy first (most specific)
    if any(w in n for w in ("papacy", "papal state", "pope")):
        return "papacy"

    # Sultanate / khanate / emirate
    if any(w in n for w in ("sultanate", "khanate", "khaganate", "emirate", "caliphate", "imamate")):
        return "sultanate"

    # Confederation / league
    if any(w in n for w in ("confederation", "confederacy", "confederate", "league", "union of")):
        return "confederation"

    # Republic / commonwealth
    if any(w in n for w in ("republic", "commonwealth")):
        return "republic"

    # Empire (check before kingdom — "Holy Roman Empire" should be empire not kingdom)
    if "empire" in n or "imperial" in n:
        return "empire"

    # Kingdom / monarchy (top-level sovereign)
    if any(w in n for w in ("kingdom", "monarchy")):
        return "kingdom"

    # Principality / duchy / sub-state (subordinate to a larger polity)
    if any(w in n for w in (
        "principality", "grand duchy", "duchy", "dukedom",
        "electorate", "margraviate", "landgraviate", "palatinate",
        "archduchy", "marquisate", "countship", "lordship",
        "princely state", "native state",
    )):
        return "principality"

    # Colony / dependency (subordinate to a metropole)
    if any(w in n for w in (
        "colony", "colonial", "protectorate", "viceroyalty", "viceroy",
        "captaincy general", "captaincy-general", "crown colony",
        "dependency", "overseas territory",
    )):
        return "colony"

    return "other"


def classify_location(
    p31_qids: list[str],
    extra_map: Optional[dict[str, Optional[str]]] = None,
) -> Optional[str]:
    """
    Classifies a Wikidata location entity by its P31 (instance-of) QIDs.

    Returns:
        'city'    — human settlement (pin to exact city coords)
        'region'  — sub-national admin area or geographic region
        'country' — sovereign state, empire, historical country
        None      — pure geographic feature (river, mountain, etc.) — exclude

    Resolution order (country wins over city wins over region wins over exclude):
        1. Any _COUNTRY_P31 match → 'country'  (sovereign state beats city type)
        2. Any _CITY_P31 match → 'city'
        3. Any _REGION_P31 match → 'region'
        4. Any _EXCLUDE_P31 match → None (exclude)
        5. extra_map (transitive SPARQL results) — same priority order
        6. Unknown P31 → 'city' (safe default, preserves existing behavior)

    extra_map: optional {qid: 'city'|'region'|'country'|None} dict from a
               transitive P279* SPARQL lookup, used as fallback when no
               hardcoded set matches.  None value means 'exclude'.
    """
    if any(q in _COUNTRY_P31 for q in p31_qids):
        return "country"
    if any(q in _CITY_P31 for q in p31_qids):
        return "city"
    if any(q in _REGION_P31 for q in p31_qids):
        return "region"
    if any(q in _EXCLUDE_P31 for q in p31_qids):
        return None  # exclude

    # Transitive fallback via dynamic SPARQL map (country > city > region)
    if extra_map:
        _PRIORITY: dict[str, int] = {"country": 3, "city": 2, "region": 1}
        best_type: Optional[str] = None
        has_exclude = False
        for q in p31_qids:
            if q not in extra_map:
                continue
            t = extra_map[q]
            if t is None:
                has_exclude = True
            elif best_type is None or _PRIORITY.get(t, 0) > _PRIORITY.get(best_type, 0):
                best_type = t
        if best_type is not None:
            return best_type
        if has_exclude:
            return None

    return "city"   # unknown P31 → default to city


# ---------------------------------------------------------------------------
# Slug generation
# ---------------------------------------------------------------------------

def make_slug(wikipedia_title: str) -> str:
    """
    Returns the Wikipedia URL path component for an article title.
    Spaces become underscores — exactly matching the Wikipedia URL format.
    e.g. 'Battle of Thermopylae' → 'Battle_of_Thermopylae'
         'Rome'                   → 'Rome'
    """
    return wikipedia_title.replace(" ", "_")


# ---------------------------------------------------------------------------
# Main extraction function
# ---------------------------------------------------------------------------

def extract_event(entity: dict) -> dict:
    """
    Extracts structured fields from a raw Wikidata entity dict.

    Returns a dict with all columns needed for the events table, plus:
      - wikidata_qid, slug (for new schema columns)
      - _needs_* flags for downstream enrichment routing

    This function is the core of the pipeline. It is called identically from
    run_local.py (one entity at a time) and run_spark.py (via mapPartitions).
    """
    qid = entity.get("id")
    labels = entity.get("labels", {})
    sitelinks = entity.get("sitelinks", {})
    claims = entity.get("claims", {})

    # English label and Wikipedia link
    # Wikidata uses sentence case (lowercase first word) for many labels.
    # Capitalize the first character so display titles look correct.
    label_en = labels.get("en", {}).get("value")
    if label_en:
        label_en = label_en[0].upper() + label_en[1:]
    enwiki = sitelinks.get("enwiki", {})
    wikipedia_title = enwiki.get("title")
    wikipedia_url = (
        f"https://en.wikipedia.org/wiki/{wikipedia_title.replace(' ', '_')}"
        if wikipedia_title else None
    )
    slug = make_slug(wikipedia_title) if wikipedia_title else None

    # Dates — prefer P585 (point in time), fall back to P580/P582 (start/end)
    point_time, point_prec = get_time_value(claims, "P585")
    start_time, start_prec = get_time_value(claims, "P580")
    end_time,   end_prec   = get_time_value(claims, "P582")

    if point_time:
        year_start, month_start, day_start, date_is_fuzzy = parse_wikidata_time(point_time, point_prec)
        year_end, month_end, day_end = None, None, None
    elif start_time:
        year_start, month_start, day_start, date_is_fuzzy = parse_wikidata_time(start_time, start_prec)
        if end_time:
            year_end, month_end, day_end, _ = parse_wikidata_time(end_time, end_prec)
        else:
            year_end, month_end, day_end = None, None, None
    else:
        year_start, month_start, day_start, date_is_fuzzy = None, None, None, True
        year_end, month_end, day_end = None, None, None

    # Spatial
    lat, lon = get_coord(claims)
    location_qid = get_item_id(claims, "P276")  # location entity (city/region)
    country_qid  = get_item_id(claims, "P17")   # country entity

    if lat is not None and lon is not None:
        location_level = "point"
    elif location_qid:
        location_level = "city"   # updated to 'region'/'country' after QID resolution
    else:
        location_level = None     # unknown → needs LLM assignment

    # Categories
    p31_qids = [v["id"] for v in get_all_claim_values(claims, "P31") if isinstance(v, dict)]
    categories, needs_llm_category = map_categories(p31_qids)

    # P361 "part of" — parent event/conflict this entity belongs to
    # e.g. Battle of Cannae → [Q154430 (Second Punic War)]
    part_of_qids = [v["id"] for v in get_all_claim_values(claims, "P361") if isinstance(v, dict)]

    return {
        # Identity
        "wikidata_qid":      qid,
        "title":             label_en,
        "wikipedia_title":   wikipedia_title,
        "wikipedia_url":     wikipedia_url,
        "slug":              slug,
        "wikipedia_summary": None,   # filled by Wikipedia REST API / DBpedia join

        # Temporal
        "year_start":        year_start,
        "month_start":       month_start,
        "day_start":         day_start,
        "year_end":          year_end,
        "month_end":         month_end,
        "day_end":           day_end,
        "date_is_fuzzy":     date_is_fuzzy,
        "date_range_min":    None,
        "date_range_max":    None,

        # Spatial (raw Wikidata values — resolved further in run_local / run_spark)
        "location_level":    location_level,
        "lat":               lat,
        "lon":               lon,
        "location_qid":      location_qid,    # P276 QID → resolved to city UUID at load time
        "country_qid":       country_qid,     # P17 QID  → used for location_name fallback
        "location_name":     None,            # filled after QID resolution

        # Classification
        "p31_qids":              p31_qids,
        "categories":            categories,
        "part_of_qids":          part_of_qids,

        # Enrichment routing flags (not persisted to DB)
        "_needs_llm_category":            needs_llm_category and not categories,
        "_needs_location":                location_level is None,
        "_needs_location_qid_resolution": location_level == "city",
    }

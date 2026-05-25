"""Quick Observer pattern and guidance data.

This module contains ONLY data definitions (no logic). Edit patterns or guidance
text here without needing to understand the analysis engine in quick_observer.py.
The active Quick Observer imports companion-call categories only; older
health/safety/ADL/cognitive pattern tables remain here for legacy reference.
"""

import re
from dataclasses import dataclass


@dataclass
class Pattern:
    pattern: re.Pattern
    signal: str
    severity: str = "low"
    valence: str = ""
    intensity: str = "medium"
    strength: str = ""
    type: str = ""
    confidence: float = 0.0


def _p(pat: str, signal: str, **kw) -> Pattern:
    return Pattern(pattern=re.compile(pat, re.IGNORECASE), signal=signal, **kw)


# =============================================================================
# Pattern definitions — active companion categories plus legacy inactive tables.
# =============================================================================

# --- HEALTH (31) ---
HEALTH_PATTERNS = [
    _p(r"\b(pain|hurt|ache|aching|sore|tender|throbbing|stabbing|burning)\b", "pain", severity="medium"),
    _p(r"\b(headache|migraine|head hurts?)\b", "headache", severity="medium"),
    _p(r"\b(back ache|back pain|my back)\b", "back_pain", severity="medium"),
    _p(r"\b(joint|arthritis|stiff|stiffness|swollen|swelling)\b", "joint_pain", severity="low"),
    _p(r"\b(dizzy|dizziness|lightheaded|light headed|woozy|vertigo|spinning)\b", "dizziness", severity="high"),
    _p(r"\b(off balance|unsteady|wobbly|lost my balance)\b", "balance_issue", severity="high"),
    _p(r"\b(fell|fall|fallen|tripped|stumbled|slipped)\b", "fall", severity="high"),
    _p(r"\b(bumped|hit my|bruise|bruised|cut myself|bleeding)\b", "injury", severity="medium"),
    _p(r"\b(blood pressure|bp|hypertension)\b", "blood_pressure", severity="medium"),
    _p(r"\b(heart|chest pain|chest tight|palpitation|racing heart|irregular heartbeat)\b", "cardiovascular", severity="high"),
    _p(r"\b(short of breath|shortness of breath|can't breathe|hard to breathe|breathing)\b", "breathing", severity="high"),
    _p(r"\b(tired|exhausted|fatigue|fatigued|weak|no energy|drained|worn out)\b", "fatigue", severity="low"),
    _p(r"\b(can't sleep|couldn't sleep|insomnia|awake all night|trouble sleeping|sleepless)\b", "sleep_issues", severity="medium"),
    _p(r"\b(slept well|good sleep|rested|feel refreshed)\b", "good_sleep", severity="positive"),
    _p(r"\b(forgot|forget|forgetful|can't remember|memory|remember when)\b", "memory_mention", severity="low"),
    _p(r"\b(confused|confusion|disoriented|don't know where|what day is it)\b", "confusion", severity="high"),
    _p(r"\b(anxious|anxiety|panic|nervous|worried sick)\b", "anxiety", severity="medium"),
    _p(r"\b(not hungry|no appetite|can't eat|haven't eaten|skipped meals?)\b", "poor_appetite", severity="medium"),
    _p(r"\b(ate|eating|breakfast|lunch|dinner|meal|food|hungry)\b", "eating", severity="low"),
    _p(r"\b(nausea|nauseous|sick to my stomach|vomit|threw up)\b", "nausea", severity="medium"),
    _p(r"\b(medicine|medication|pill|pills|prescription|refill|pharmacy)\b", "medication", severity="medium"),
    _p(r"\b(took my (medicine|medication|pills?)|already took|haven't taken)\b", "medication_status", severity="medium"),
    _p(r"\b(side effect|makes me feel|doesn't agree with me)\b", "medication_issue", severity="medium"),
    _p(r"\b(doctor|physician|dr\.|specialist|nurse|therapist)\b", "doctor_mention", severity="low"),
    _p(r"\b(appointment|checkup|check-up|follow-up|visit the doctor|see the doctor)\b", "appointment", severity="low"),
    _p(r"\b(hospital|emergency|er|urgent care|ambulance|911)\b", "emergency_mention", severity="high"),
    _p(r"\b(test|tests|blood work|x-ray|scan|mri|results)\b", "medical_test", severity="low"),
    _p(r"\b(diabetes|sugar|blood sugar|insulin)\b", "diabetes", severity="medium"),
    _p(r"\b(cold|flu|cough|sneezing|runny nose|congested|fever)\b", "cold_flu", severity="low"),
    _p(r"\b(vision|can't see|blurry|glasses|eyes)\b", "vision", severity="low"),
    _p(r"\b(hearing|can't hear|deaf|hearing aid)\b", "hearing", severity="low"),
]

# --- FAMILY (25) ---
FAMILY_PATTERNS = [
    _p(r"\b(daughter|daughters?)\b", "daughter"),
    _p(r"\b(son|sons?)\b", "son"),
    _p(r"\b(child|children|kids?)\b", "children"),
    _p(r"\b(step-?(son|daughter|child))\b", "stepchild"),
    _p(r"\b(grandchild|grandchildren|grandkids?)\b", "grandchildren"),
    _p(r"\b(grandson|grandsons?)\b", "grandson"),
    _p(r"\b(granddaughter|granddaughters?)\b", "granddaughter"),
    _p(r"\b(great-?grand(child|son|daughter|kids?))\b", "great_grandchildren"),
    _p(r"\b(husband|hubby)\b", "husband"),
    _p(r"\b(wife)\b", "wife"),
    _p(r"\b(spouse|partner|significant other)\b", "spouse"),
    _p(r"\b(passed away|late husband|late wife|widow|widower)\b", "deceased_spouse"),
    _p(r"\b(sister|sisters?)\b", "sister"),
    _p(r"\b(brother|brothers?)\b", "brother"),
    _p(r"\b(sibling|siblings?)\b", "siblings"),
    _p(r"\b(twin)\b", "twin"),
    _p(r"\b(niece|nephew|aunt|uncle|cousin)\b", "extended_family"),
    _p(r"\b(in-?law|mother-?in-?law|father-?in-?law|son-?in-?law|daughter-?in-?law)\b", "in_laws"),
    _p(r"\b(mother|mom|mama|mommy)\b", "mother"),
    _p(r"\b(father|dad|papa|daddy)\b", "father"),
    _p(r"\b(parents?)\b", "parents"),
    _p(r"\b(family|relative|relatives|kin|folks)\b", "family_general"),
    _p(r"\b(visit|visiting|came over|stopped by|came to see)\b", "visit"),
    _p(r"\b(called|phoned|texted|messaged|video call|facetime)\b", "contact"),
    _p(r"\b(birthday|anniversary|holiday|thanksgiving|christmas|easter)\b", "family_event"),
    _p(r"\b(dog|puppy|pup)\b", "dog"),
    _p(r"\b(cat|kitty|kitten)\b", "cat"),
    _p(r"\b(pet|pets?|bird|fish|hamster)\b", "pet"),
    _p(r"\b(caregiver|aide|helper|nurse|home health)\b", "caregiver"),
]

# --- EMOTION (27) ---
EMOTION_PATTERNS = [
    _p(r"\b(sad|sadness|unhappy|down|blue|depressed|gloomy|miserable)\b", "sad", valence="negative", intensity="high"),
    _p(r"\b(crying|cried|tears|weeping)\b", "crying", valence="negative", intensity="high"),
    _p(r"\b(grief|grieving|mourning|loss)\b", "grief", valence="negative", intensity="high"),
    _p(r"\b(lonely|lonesome|alone|isolated|by myself)\b", "lonely", valence="negative", intensity="high"),
    _p(r"\b(miss|missing|wish .* here|wish .* could)\b", "missing", valence="negative", intensity="medium"),
    _p(r"\b(no one (calls|visits|cares)|nobody|left alone)\b", "abandoned", valence="negative", intensity="high"),
    _p(r"\b(worried|worrying|worry|concern|concerned|fret|fretting)\b", "worried", valence="negative", intensity="medium"),
    _p(r"\b(anxious|anxiety|nervous|uneasy|on edge|tense)\b", "anxious", valence="negative", intensity="medium"),
    _p(r"\b(scared|afraid|frightened|fearful|terrified)\b", "scared", valence="negative", intensity="high"),
    _p(r"\b(overwhelmed|too much|can't cope|stressed)\b", "overwhelmed", valence="negative", intensity="high"),
    _p(r"\b(frustrated|frustrating|aggravated|annoyed|irritated)\b", "frustrated", valence="negative", intensity="medium"),
    _p(r"\b(angry|mad|furious|upset|outraged)\b", "angry", valence="negative", intensity="high"),
    _p(r"\b(hate|can't stand|sick of|fed up)\b", "resentful", valence="negative", intensity="medium"),
    _p(r"\b(bored|boring|nothing to do|same old|monotonous)\b", "bored", valence="negative", intensity="low"),
    _p(r"\b(don't care|doesn't matter|what's the point|why bother)\b", "apathetic", valence="negative", intensity="high"),
    _p(r"\b(happy|glad|pleased|delighted|joyful|cheerful)\b", "happy", valence="positive", intensity="medium"),
    _p(r"\b(good|great|wonderful|fantastic|amazing|excellent)\b", "positive", valence="positive", intensity="medium"),
    _p(r"\b(love|loved|loving|adore)\b", "love", valence="positive", intensity="high"),
    _p(r"\b(excited|exciting|thrilled|can't wait|looking forward)\b", "excited", valence="positive", intensity="high"),
    _p(r"\b(fun|enjoy|enjoyed|enjoying|having a (good|great) time)\b", "enjoying", valence="positive", intensity="medium"),
    _p(r"\b(thank|thanks|thankful|grateful|appreciate|blessed)\b", "grateful", valence="positive", intensity="medium"),
    _p(r"\b(lucky|fortunate|glad to have)\b", "fortunate", valence="positive", intensity="medium"),
    _p(r"\b(content|satisfied|at peace|peaceful|calm|relaxed)\b", "content", valence="positive", intensity="low"),
    _p(r"\b(fine|okay|alright|doing well|can't complain)\b", "neutral_positive", valence="positive", intensity="low"),
    _p(r"\b(proud|pride|accomplished|achievement)\b", "proud", valence="positive", intensity="medium"),
    _p(r"\b(so-so|not bad|could be (better|worse)|same as usual)\b", "neutral", valence="neutral", intensity="low"),
]

# --- SAFETY (14) ---
SAFETY_PATTERNS = [
    _p(r"\b(scam|fraud|suspicious|fake|phishing)\b", "scam_mention", severity="high"),
    _p(r"\b(someone (called|emailed|texted) (me|saying)|strange (call|email|message))\b", "suspicious_contact", severity="high"),
    _p(r"\b(asked for (money|bank|social security|credit card|password))\b", "info_request", severity="high"),
    # Scam-indicator vocabulary. The previous pattern matched "won" anywhere,
    # which fired SAFETY guidance "This sounds like a scam" on "Did the
    # Cowboys win their game?" — surfaced by the mock-call harness on
    # 2026-05-24. Split into two patterns:
    # 1) words that are essentially always scam-coded (lottery, sweepstakes,
    #    inheritance check, nigerian prince).
    _p(r"\b(lottery|sweepstakes|inheritance check|nigerian prince|nigerian scam|wire transfer to claim)\b", "scam_indicators", severity="high"),
    # 2) "won/winner" or "prize" only when paired with a money-shaped term
    #    within the same sentence. Sports "won" doesn't match; "I won a
    #    thousand dollars" does. [^.\n]{0,60}? keeps the proximity check
    #    inside a single sentence so cross-sentence false positives
    #    ("Cowboys won. The lottery is...") can't fire it.
    _p(
        r"\b(won|winner|prize)\b[^.\n]{0,60}?\b(lottery|sweepstakes|jackpot|millions?|thousand dollars?|hundred dollars?|cash prize|grand prize|inheritance|\$\d|usd|\d+\s?dollars?)\b",
        "scam_indicators",
        severity="high",
    ),
    _p(r"\b(irs|tax|government|medicare) (called|saying|claims)\b", "government_scam", severity="high"),
    _p(r"\b(stranger|someone (came|knocked|at the door)|don't know (who|them))\b", "stranger", severity="medium"),
    _p(r"\b(locked out|can't (get in|find my keys)|lost (my )?keys?)\b", "locked_out", severity="medium"),
    _p(r"\b(break-?in|burglar|robbery|stolen|broke into)\b", "break_in", severity="high"),
    _p(r"\b(smoke|fire|burning|alarm going off)\b", "fire", severity="high"),
    _p(r"\b(gas smell|smell gas|leak)\b", "gas_leak", severity="high"),
    _p(r"\b(lost|can't find my way|don't know where I am|confused about where)\b", "lost", severity="high"),
    _p(r"\b(wandered|wandering|ended up somewhere)\b", "wandering", severity="medium"),
    _p(r"\b(accident|crash|fender bender|hit (something|someone|a car))\b", "accident", severity="high"),
    _p(r"\b(driving|drove|car|vehicle)\b", "driving_mention", severity="low"),
]

# --- SOCIAL (10) ---
SOCIAL_PATTERNS = [
    _p(r"\b(friend|friends|buddy|pal|bestie)\b", "friend"),
    _p(r"\b(old friend|childhood friend|known for years|best friend)\b", "close_friend"),
    _p(r"\b(neighbor|neighbours?|next door|across the street)\b", "neighbor"),
    _p(r"\b(church|temple|synagogue|mosque|congregation|service|mass)\b", "religious_community"),
    _p(r"\b(club|group|class|meeting|bingo|cards|bridge)\b", "social_group"),
    _p(r"\b(senior center|community center|library|rec center)\b", "community_center"),
    _p(r"\b(volunteer|volunteering|helping)\b", "volunteering"),
    _p(r"\b(went out|going out|get together|gathering|party|dinner party)\b", "social_outing"),
    _p(r"\b(coffee|tea|lunch|dinner) with\b", "social_meal"),
    _p(r"\b(haven't seen anyone|no visitors|nobody came)\b", "social_isolation"),
]

# --- ACTIVITY (18) ---
ACTIVITY_PATTERNS = [
    _p(r"\b(reading|read|book|books|magazine|newspaper)\b", "reading"),
    _p(r"\b(tv|television|watching|show|movie|program)\b", "watching_tv"),
    _p(r"\b(knitting|crocheting|sewing|quilting|crafts?)\b", "crafts"),
    _p(r"\b(puzzle|crossword|sudoku|word search|jigsaw)\b", "puzzles"),
    _p(r"\b(cook|cooking|bake|baking|recipe|kitchen)\b", "cooking"),
    _p(r"\b(clean|cleaning|housework|laundry|dishes)\b", "housework"),
    _p(r"\b(garden|gardening|plant|plants|flowers?|yard|lawn)\b", "gardening"),
    _p(r"\b(walk|walking|stroll|went for a walk|took a walk)\b", "walking"),
    _p(r"\b(exercise|exercising|workout|gym|yoga|stretching)\b", "exercise"),
    _p(r"\b(bird|birds|bird ?watching|feeder)\b", "bird_watching"),
    _p(r"\b(music|sing|singing|song|piano|guitar|instrument)\b", "music"),
    _p(r"\b(paint|painting|art|draw|drawing|sketch)\b", "art"),
    _p(r"\b(golf|bowling|tennis|swim|swimming)\b", "sports"),
    _p(r"\b(fish|fishing|hunt|hunting)\b", "outdoor_sports"),
    _p(r"\b(travel|trip|vacation|cruise|visit|visited)\b", "travel"),
    _p(r"\b(computer|laptop|tablet|ipad|phone|smartphone)\b", "technology"),
    _p(r"\b(email|internet|facebook|google|youtube)\b", "online"),
]

# --- TIME (12) ---
TIME_PATTERNS = [
    _p(r"\b(remember when|back when|used to|in my day|years ago|long time ago)\b", "reminiscing"),
    _p(r"\b(when I was (young|younger|a (kid|child|girl|boy)))\b", "childhood_memory"),
    _p(r"\b(the (old|good old) days|how things were|things have changed)\b", "nostalgia"),
    _p(r"\b(yesterday|last (night|week|month)|the other day|recently|lately)\b", "recent_past"),
    _p(r"\b(this morning|this afternoon|earlier (today)?|just now|a while ago)\b", "today"),
    _p(r"\b(tomorrow|next (week|month)|upcoming|coming up|soon)\b", "near_future"),
    _p(r"\b(plan|plans|planning|going to|gonna|will be)\b", "future_plans"),
    _p(r"\b(looking forward|can't wait|excited about)\b", "anticipation"),
    _p(r"\b(schedule|appointment|at (\d+|noon|morning|afternoon|evening))\b", "schedule"),
    _p(r"\b(routine|every (day|morning|night|week)|usually|normally)\b", "routine"),
]

# --- ENVIRONMENT (8) ---
ENVIRONMENT_PATTERNS = [
    _p(r"\b(weather|forecast|temperature|degrees)\b", "weather"),
    _p(r"\b(rain|raining|rainy|storm|stormy|thunder|lightning)\b", "rain"),
    _p(r"\b(snow|snowing|snowy|ice|icy|slippery|cold)\b", "snow_ice"),
    _p(r"\b(hot|heat|humid|warm|sunny|beautiful day)\b", "warm_weather"),
    _p(r"\b(spring|summer|fall|autumn|winter|season)\b", "season"),
    _p(r"\b(power out|no power|electricity|outage)\b", "power_outage"),
    _p(r"\b(heat|heating|furnace|thermostat|ac|air condition)\b", "home_temperature"),
]

# --- ADL (13) ---
ADL_PATTERNS = [
    _p(r"\b(can't (get in|get out of) (the )?(shower|tub|bath))\b", "bathing_difficulty", severity="high"),
    _p(r"\b(trouble (showering|bathing|washing)|hard to (shower|bathe|wash))\b", "bathing_difficulty", severity="high"),
    _p(r"\b(haven't (showered|bathed|washed) in|skip(ped)? (my )?(shower|bath))\b", "hygiene_concern", severity="medium"),
    _p(r"\b(can't (get dressed|put on|button|zip|tie))\b", "dressing_difficulty", severity="medium"),
    _p(r"\b(trouble (dressing|getting dressed|with (buttons|zippers|shoelaces)))\b", "dressing_difficulty", severity="medium"),
    _p(r"\b(hard to (reach|bend|lift my arms))\b", "mobility_limitation", severity="medium"),
    _p(r"\b(accident|accidents|wet myself|soiled|incontinence|bladder|bowel)\b", "continence_issue", severity="high"),
    _p(r"\b(trouble (getting to|using) the (bathroom|toilet))\b", "toileting_difficulty", severity="high"),
    _p(r"\b(can't (get up|stand up|get out of (bed|chair))|trouble (standing|getting up))\b", "transfer_difficulty", severity="high"),
    _p(r"\b(need(ed)? help (getting up|standing|walking))\b", "mobility_assistance", severity="high"),
    _p(r"\b(use a (walker|cane|wheelchair)|started using)\b", "mobility_aid", severity="low"),
    _p(r"\b(stuck in (bed|chair)|couldn't (move|get up))\b", "immobility", severity="high"),
    _p(r"\b(can't (brush|comb|cut|trim)|trouble with (my )?(hair|nails|teeth))\b", "grooming_difficulty", severity="low"),
    _p(r"\b(can't do (it|things) (myself|alone|anymore)|need(ed)? help (with everything|doing))\b", "independence_loss", severity="high"),
    _p(r"\b(losing my independence|not independent|depend on)\b", "independence_concern", severity="medium"),
]

# --- COGNITIVE (9) ---
COGNITIVE_PATTERNS = [
    _p(r"\b(can't (think of|remember) the word|what's (it|that) called|you know what I mean)\b", "word_finding", severity="low"),
    _p(r"\b(tip of my tongue|brain (fog|freeze)|mind (went blank|is blank))\b", "word_finding", severity="low"),
    _p(r"\b(what (day|year|month) is it|forgot what (day|year)|lost track of (time|days))\b", "time_confusion", severity="medium"),
    _p(r"\b(thought (it was|today was)|didn't realize|mixed up the (days|dates))\b", "time_confusion", severity="medium"),
    _p(r"\b(put (the|my) .* in the (fridge|freezer|oven|microwave|closet))\b", "object_misplacement", severity="high"),
    _p(r"\b(found (my|the) .* in (a strange|the wrong|an odd) place)\b", "object_misplacement", severity="medium"),
    _p(r"\b(keep losing|can't find (my|the)|where did I put)\b", "misplacing_items", severity="low"),
    _p(r"\b(forgot (what I was|why I) (doing|came|went)|what was I (doing|saying))\b", "task_confusion", severity="medium"),
    _p(r"\b(started to .* (and|but) forgot|couldn't (finish|remember how))\b", "task_confusion", severity="medium"),
    _p(r"\b(didn't recognize|who (is|was) that|couldn't (place|remember) (them|who))\b", "recognition_issue", severity="high"),
    _p(r"\b(got lost (going|coming|driving|walking)|couldn't find my way)\b", "navigation_confusion", severity="high"),
    _p(r"\b(familiar place.*(confus|lost)|didn't know where I was)\b", "navigation_confusion", severity="high"),
]

# --- HELP REQUEST (6) ---
HELP_REQUEST_PATTERNS = [
    _p(r"\b(can you help|could you help|help me (with|to|understand))\b", "direct_help_request"),
    _p(r"\b(I need help (with|to|doing)|need (some|your) help)\b", "direct_help_request"),
    _p(r"\b(do you know (how|what|where|when|why)|what should I do)\b", "advice_request"),
    _p(r"\b(can you (tell|explain|remind)|would you (mind|be able to))\b", "information_request"),
    _p(r"\b(I('m| am) (confused|not sure|unsure) (about|how|what))\b", "clarification_request"),
    _p(r"\b(how do (I|you)|what('s| is) the (best|right) way)\b", "guidance_request"),
]

# --- END OF LIFE (8) ---
END_OF_LIFE_PATTERNS = [
    _p(r"\b(when I('m| am) gone|after I('m| am) gone|when I die|if I die)\b", "mortality_mention", severity="medium"),
    _p(r"\b(don't have (much|long) (time|left)|not (long|much time) (for|left))\b", "mortality_mention", severity="medium"),
    _p(r"\b(my (time|days) (are|is) (numbered|limited|running out))\b", "mortality_mention", severity="medium"),
    _p(r"\b(will (and testament)?|living will|estate|power of attorney)\b", "estate_planning", severity="low"),
    _p(r"\b(getting (my )?affairs in order|putting things in order)\b", "estate_planning", severity="low"),
    _p(r"\b(don't want to be a burden|burden (on|to) (my|the)|being a burden)\b", "burden_concern", severity="high"),
    _p(r"\b((everyone|they)'d be better off|better off without me)\b", "burden_concern", severity="high"),
    _p(r"\b(what's the point|why bother|no point (in|anymore)|given up)\b", "hopelessness", severity="high"),
    _p(r"\b(rather (die|not wake up|be dead)|ready to (go|die)|tired of living)\b", "death_wish", severity="high"),
    _p(r"\b(want(ed)? to say goodbye|in case (something|anything) happens)\b", "farewell_concern", severity="high"),
]

# --- HYDRATION (8) ---
HYDRATION_PATTERNS = [
    _p(r"\b(haven't (had|drunk|drank) (water|anything)|not drinking (enough|much))\b", "dehydration_risk", severity="high"),
    _p(r"\b(very thirsty|so thirsty|mouth is dry|dry mouth)\b", "dehydration_symptom", severity="medium"),
    _p(r"\b(dark (urine|pee)|not (peeing|urinating) (much|enough))\b", "dehydration_symptom", severity="high"),
    _p(r"\b(lost (a lot of )?weight|losing weight|clothes (are|feel) (loose|big))\b", "weight_loss", severity="high"),
    _p(r"\b(not (eating|hungry)|no appetite|can't eat|haven't eaten (in|for))\b", "poor_nutrition", severity="high"),
    _p(r"\b(skip(ped|ping)? meals?|forgot to eat|too tired to (eat|cook))\b", "missed_meals", severity="medium"),
    _p(r"\b(drinking (lots of |more )?water|staying hydrated|ate (well|good))\b", "good_nutrition", severity="positive"),
    _p(r"\b(good appetite|eating (well|better)|gained (some )?weight)\b", "good_nutrition", severity="positive"),
    _p(r"\b(trouble swallowing|hard to swallow|chok(e|ed|ing) on|food (gets|got) stuck)\b", "swallowing_difficulty", severity="high"),
]

# --- TRANSPORTATION (8) ---
TRANSPORTATION_PATTERNS = [
    _p(r"\b(can't drive (anymore)?|stopped driving|gave up (driving|my car|the keys))\b", "driving_cessation", severity="medium"),
    _p(r"\b(took (away )?my (keys|license|car)|not (allowed|supposed) to drive)\b", "driving_restriction", severity="medium"),
    _p(r"\b(shouldn't (be )?driv(e|ing)|dangerous (to|for me to) drive)\b", "driving_concern", severity="medium"),
    _p(r"\b(need(ed)? a ride|can't get (there|to)|no (way to get|transportation))\b", "transportation_need", severity="medium"),
    _p(r"\b(stuck at home|can't (go|get) anywhere|no way to (leave|get out))\b", "homebound", severity="high"),
    _p(r"\b(miss(ing)? (my car|driving|going out)|wish I could (drive|go))\b", "mobility_loss_grief", severity="medium"),
    _p(r"\b(depend on .* (for rides|to take me)|have to (ask|wait) for)\b", "transportation_dependency", severity="low"),
    _p(r"\b(uber|lyft|taxi|cab|bus|public transit|paratransit)\b", "alternative_transport", severity="low"),
    _p(r"\b(missed .* (because|couldn't get)|can't get to (my )?appointment)\b", "missed_due_to_transport", severity="high"),
]

# --- NEWS / WEB SEARCH (23) ---
NEWS_PATTERNS = [
    _p(r"\b(news|headline|headlines)\b", "news_request"),
    _p(r"\b(what('s| is) happening|what('s| is) going on)\b", "news_request"),
    _p(r"\b(current events|latest)\b", "news_request"),
    _p(r"\b(weather|forecast)\b", "weather_request"),
    _p(r"\b(president|election|politics|political)\b", "news_request"),
    _p(r"\b(stock market|economy|economic)\b", "news_request"),
    _p(r"\b(sports|game|score|scores)\b", "sports_request"),
    _p(r"\b(look (that |it |this )?up|look up)\b", "search_request"),
    _p(r"\b(search for|search (the )?internet|google)\b", "search_request"),
    _p(r"\b(can you (find|check|look)|could you (find|check|look))\b", "search_request"),
    _p(r"\b(find out|figure out) (about|what|who|where|when|why|how)\b", "search_request"),
    _p(r"\b(do you know (what|who|where|when|why|how))\b", "search_request"),
    _p(r"\b(what('s| is) the (best|top|most))\b", "search_request"),
    _p(r"\bwhat year did\b", "factual_question"),
    _p(r"\bhow many\b.*\b(are there|does|did|in the|in a)\b", "factual_question"),
    _p(r"\bwho (was|is|were|invented|discovered|founded|wrote|created)\b", "factual_question"),
    _p(r"\bwhat is the\b.{3,}", "factual_question"),
    _p(r"\bwhat are the\b.{3,}", "factual_question"),
    _p(r"\bwhen did\b.{3,}", "factual_question"),
    _p(r"\bhow long ago\b", "factual_question"),
    _p(r"\bwhat happened in\b", "factual_question"),
    _p(r"\bhow (tall|old|big|far|deep|long|fast|heavy|much does) is\b", "factual_question"),
    _p(r"\bwhat('s| is) the (population|capital|distance|height|size|age) of\b", "factual_question"),
    _p(r"\bwhere is\b.{3,}\b(located|at)\b", "factual_question"),
    _p(r"\bI wonder\b", "curiosity_question"),
    _p(r"\bI('m| am) curious (about|if|whether)\b", "curiosity_question"),
    _p(r"\bhave you heard about\b", "curiosity_question"),
    _p(r"\btell me about\b.{3,}", "curiosity_question"),
    _p(r"\bwhat do you know about\b", "curiosity_question"),
]

# --- GOODBYE (11) ---
GOODBYE_PATTERNS = [
    _p(r"\b(goodbye|good bye|bye bye)\b", "goodbye", strength="strong"),
    _p(r"\bbye\b", "goodbye", strength="weak"),
    _p(r"\b(goodnight|good night|nighty night)\b", "goodnight", strength="strong"),
    _p(r"\b(talk to you (later|soon|tomorrow|next time))\b", "talk_later", strength="strong"),
    _p(r"\b(see you (later|soon|tomorrow|next time))\b", "see_you", strength="strong"),
    _p(r"\b(take care( of yourself)?)\b", "take_care", strength="weak"),
    _p(r"\b(have a (good|great|nice|lovely|wonderful) (day|night|evening|afternoon|one))\b", "have_good_day", strength="weak"),
    _p(r"\b(i('ll| will) let you go)\b", "let_you_go", strength="strong"),
    _p(r"\b(i (should|gotta|got to|have to|need to|better) go)\b", "need_to_go", strength="strong"),
    _p(r"\b(thanks for (calling|the call|chatting|talking))\b", "thanks_for_call", strength="strong"),
    _p(r"\b(nice (talking|chatting|speaking) (to|with) you)\b", "nice_talking", strength="strong"),
    _p(r"\b(it was (nice|great|lovely|good) (talking|chatting))\b", "nice_talking", strength="strong"),
    _p(r"\b(i('m| am) (going to|gonna) (go|leave|hang up))\b", "going_to_go", strength="strong"),
    _p(r"\b(let me go|do you mind if i (go|leave))\b", "let_me_go", strength="strong"),
]

# --- QUESTION (5) ---
QUESTION_PATTERNS = [
    _p(r"\?$", "explicit_question"),
    _p(r"^(what|where|when|why|how|who|which)\b", "wh_question"),
    _p(r"^(do|does|did|is|are|was|were|can|could|would|will|have|has)\b.*\?", "yes_no_question"),
    _p(r"\b(tell me|let me know|do you know|wondering|I wonder)\b", "information_request"),
    _p(r"\b(what do you think|your opinion|should I|would you)\b", "opinion_request"),
]

# --- ENGAGEMENT (5) ---
ENGAGEMENT_PATTERNS = [
    _p(r"^(yes|no|ok|okay|sure|fine|mm|hmm|uh huh|yeah|yep|nope|nah|mhm)\.?$", "minimal_response"),
    _p(r"^(i don't know|not sure|maybe|i guess|i suppose)\.?$", "uncertain_response"),
    _p(r"^.{1,10}$", "very_short"),
    _p(r"^.{1,25}$", "short"),
    _p(r"^.{100,}$", "long_response"),
]

# --- REMINDER ACKNOWLEDGMENT (11) ---
REMINDER_ACK_PATTERNS = [
    _p(r"\b(ok(ay)?|sure|yes|will do|got it|i('ll| will) (take|do|remember)|sounds good|alright)\b", "ack", type="acknowledged", confidence=0.8),
    _p(r"\b(thank(s| you)|appreciate|good reminder|glad you (called|reminded)|thanks for reminding)\b", "ack", type="acknowledged", confidence=0.7),
    _p(r"\b(i('ll| will) get (to it|on it|it done)|going to (take|do) it|about to (take|do))\b", "ack", type="acknowledged", confidence=0.9),
    _p(r"\b(won't forget|i'll remember|good to know)\b", "ack", type="acknowledged", confidence=0.75),
    _p(r"\b(i('ll| will) (do that|do it|take care of it)|right away|right after)\b", "ack", type="acknowledged", confidence=0.85),
    _p(r"\b(you('re| are) right|good idea|i should)\b", "ack", type="acknowledged", confidence=0.7),
    _p(r"\b(already (took|did|done|finished|had|taken)|just (took|did|finished)|i('ve| have) (taken|done|had|finished))\b", "conf", type="confirmed", confidence=0.95),
    _p(r"\b(took (it|them|my|the)|did (it|that)|done( with)?( it)?|finished|completed)\b", "conf", type="confirmed", confidence=0.85),
    _p(r"\b(earlier|this morning|a (few )?minutes ago|before you called|right before)\b", "conf", type="confirmed", confidence=0.8),
    _p(r"\b(i already took my (medicine|medication|pills?)|already (had|done) (it|that|my))\b", "conf", type="confirmed", confidence=0.95),
    _p(r"\b(yes i did( that)?|already done|already did)\b", "conf", type="confirmed", confidence=0.9),
]


# =============================================================================
# Guidance text — signal-to-guidance mappings for _build_guidance()
# =============================================================================

# SAFETY guidance — two design tiers (revised 2026-05-24):
#
# 1. Scam-shaped signals (scam_mention / suspicious_contact / info_request /
#    scam_indicators / government_scam / stranger): Donna is NOT a
#    fraud-prevention service. Telling a senior mid-call "this sounds like
#    a scam" is preachy, risks false-positive interrogation of benign
#    events, and isn't something they can usefully act on while on the
#    phone with us. The goal is narrower: do not VALIDATE or CONGRATULATE
#    the scam framing. Caregivers see the signal in post-call analysis +
#    transcript review; that's the right channel for "should we worry
#    about this".
#
# 2. Real-time emergencies (fire / gas_leak / break_in / locked_out /
#    lost / wandering / accident): these ARE situations Donna can help
#    with in the call — by asking if they're safe, suggesting 911, helping
#    them think through who to call. Guidance stays prescriptive.
SAFETY_GUIDANCE = {
    # --- Scam-shaped: stay curious-neutral. No advice, no lectures.
    "scam_mention": "SCAM-SHAPED — stay curious-neutral. Do not lecture, interrogate, or warn. Listen, acknowledge, move on naturally.",
    "suspicious_contact": "SCAM-SHAPED — stay neutral. Light curiosity is fine; do not advise or instruct.",
    "info_request": "SCAM-SHAPED — stay neutral. Do not congratulate, coach, or lecture.",
    "scam_indicators": "SCAM-SHAPED — do NOT validate or congratulate. Treat as a normal topic, stay neutral, move on.",
    "government_scam": "SCAM-SHAPED — stay neutral. Do not advise or instruct.",
    "stranger": "STRANGER-AT-DOOR — stay neutral. Do not lecture or interrogate; it's likely benign (mail, neighbor).",
    # --- Real-time emergencies: keep prescriptive guidance.
    "locked_out": "They're locked out. Ask if they need help calling someone.",
    "break_in": "URGENT: Possible break-in. Ask if they are safe. Consider if they need help.",
    "fire": "URGENT: Fire/smoke mentioned. Ask if they are safe and if they need to call 911.",
    "gas_leak": "URGENT: Gas leak suspected. They should leave and call emergency services.",
    "lost": "They seem lost or disoriented. Ask where they are and if someone can help.",
    "wandering": "They may have wandered. Ask where they are now.",
    "accident": "They had an accident. Ask if they are hurt and if they need help.",
}

EOL_GUIDANCE = {
    "death_wish": "CRITICAL: They expressed wanting to die. Be very gentle. Ask if they're okay. Listen. Consider if caregiver should be alerted.",
    "hopelessness": "They sound hopeless. Acknowledge their feelings. Remind them you care. Ask what's making them feel this way.",
    "burden_concern": "They feel like a burden. Reassure them they are loved and valued. Ask what's making them feel this way.",
    "mortality_mention": "They mentioned their mortality. Be gentle. Let them share if they want to talk about it.",
    "estate_planning": "They mentioned their affairs/will. Acknowledge this is important. Ask if there's anything on their mind.",
    "farewell_concern": "They seem to be saying goodbye. Ask gently if everything is okay.",
}

ADL_GUIDANCE = {
    "bathing_difficulty": "Trouble bathing is concerning. Ask gently if they're getting help with this.",
    "hygiene_concern": "Hygiene concern. Ask gently if everything is okay at home.",
    "dressing_difficulty": "Trouble dressing. Ask if they have help with this.",
    "mobility_limitation": "Mobility limitation. Ask how they're managing.",
    "continence_issue": "Sensitive topic. Be very gentle. Ask if they have supplies and support.",
    "toileting_difficulty": "Toileting difficulty. Ask gently if they have help.",
    "transfer_difficulty": "Trouble getting up is a fall risk. Ask if they've told someone.",
    "mobility_assistance": "They need help moving. Ask who helps them.",
    "mobility_aid": "They use a mobility aid. Ask how it's working for them.",
    "immobility": "They were stuck. This is concerning. Ask if they're okay now.",
    "grooming_difficulty": "Ask if they have help with grooming.",
    "independence_loss": "Loss of independence is hard. Acknowledge their feelings. Ask how they're coping.",
    "independence_concern": "Acknowledge this is difficult. Ask how they're managing.",
}

COGNITIVE_GUIDANCE = {
    "word_finding": "Word-finding difficulty. Be patient. Help them if they need it.",
    "time_confusion": "Time confusion. Gently orient them. Ask if this happens often.",
    "object_misplacement": "Unusual object placement. Ask gently if this has happened before.",
    "misplacing_items": "Everyone loses things. Be reassuring.",
    "task_confusion": "They lost track of what they were doing. Be patient and help redirect.",
    "recognition_issue": "Recognition difficulty is concerning. Ask gently about this.",
    "navigation_confusion": "Getting lost is concerning. Ask if they got home safely. Who knows about this?",
}

HYDRATION_GUIDANCE = {
    "dehydration_risk": "Not drinking enough. Encourage them to get some water now.",
    "dehydration_symptom": "Possible dehydration. Encourage fluids. Ask how they're feeling.",
    "weight_loss": "Weight loss is concerning. Ask if they're eating okay. Have they told their doctor?",
    "poor_nutrition": "Poor appetite is concerning. Ask what's making it hard to eat.",
    "missed_meals": "Skipping meals. Encourage them to eat something. Ask why they're skipping.",
    "good_nutrition": "Great that they're eating well! Reinforce this.",
    "swallowing_difficulty": "Swallowing problems are serious. Ask if they've told their doctor.",
}

TRANSPORT_GUIDANCE = {
    "driving_cessation": "Not driving anymore is a big change. Acknowledge the loss of independence.",
    "driving_restriction": "Having driving restricted is hard. Acknowledge their feelings.",
    "driving_concern": "Ask about their driving concerns. Safety is important.",
    "transportation_need": "They need transportation. Ask if they have someone who can help.",
    "homebound": "Being stuck at home is isolating. Ask how they're coping. Who can help?",
    "mobility_loss_grief": "They miss driving. Acknowledge this loss. Ask how they're getting around.",
    "transportation_dependency": "Depending on others is hard. Ask how it's going.",
    "alternative_transport": "Ask how the transportation service is working for them.",
    "missed_due_to_transport": "They missed something due to transport. This is concerning. Ask if they can reschedule.",
}

HEALTH_GUIDANCE = {
    "pain": "Show empathy about their pain. Ask where it hurts and how long.",
    "headache": "Ask how bad the headache is and if they've taken anything for it.",
    "back_pain": "Ask about their back pain. Is it new or ongoing?",
    "joint_pain": "Ask about their joint pain. Is it bothering them today?",
    "dizziness": "Express concern about dizziness. Ask if they should sit down.",
    "balance_issue": "Balance issues are concerning. Ask if they should sit down.",
    "fall": "IMPORTANT: Ask if they are okay and if anyone knows about the fall.",
    "injury": "Ask about the injury. Do they need help?",
    "blood_pressure": "Ask if they've checked their blood pressure recently.",
    "cardiovascular": "Heart/chest mentioned. Ask how they are feeling right now.",
    "breathing": "Breathing issues are serious. Ask if they are okay right now.",
    "fatigue": "Ask if they've been getting enough rest.",
    "sleep_issues": "Ask how long they've had trouble sleeping.",
    "good_sleep": "Good that they slept well! Ask what helped.",
    "memory_mention": "Memory came up. Be reassuring - everyone forgets things.",
    "confusion": "They seem confused. Speak clearly and ask simple questions.",
    "anxiety": "Acknowledge their worry. Ask what's on their mind.",
    "poor_appetite": "Ask when they last ate. Encourage them to eat something.",
    "eating": "Ask what they had. Make sure they're eating well.",
    "nausea": "Ask if they're feeling sick. Should they call the doctor?",
    "medication": "Ask if they've taken their medication today.",
    "medication_status": "They mentioned medication. Follow up on this.",
    "medication_issue": "Medication side effects - ask what's happening.",
    "doctor_mention": "Ask about their doctor/appointment.",
    "appointment": "Ask when their appointment is or how it went.",
    "emergency_mention": "Emergency/hospital mentioned. Ask if everything is okay.",
    "medical_test": "Ask about their test/results.",
    "diabetes": "Ask about their blood sugar management.",
    "cold_flu": "Ask how they're feeling. Are they getting rest?",
    "vision": "Ask about their vision. Any problems seeing?",
    "hearing": "Speak clearly. Ask if they can hear you well.",
}

EMOTION_GUIDANCE = {
    "sad": "Acknowledge their sadness. Ask what's on their mind.",
    "crying": "They mentioned crying. Be very gentle. Ask if they want to talk about it.",
    "grief": "They're grieving. Be very gentle and just listen.",
    "lonely": "Be extra warm. Ask about their day. They need connection.",
    "missing": "They miss someone. Ask who and share in remembering.",
    "abandoned": "They feel alone. Reassure them you're here for them.",
    "worried": "Ask what's worrying them. Listen and acknowledge.",
    "anxious": "Ask what's making them anxious. Be calming.",
    "scared": "They're scared. Ask what's frightening them. Reassure.",
    "overwhelmed": "They're overwhelmed. Ask what's too much right now.",
    "frustrated": "Acknowledge their frustration. Ask what happened.",
    "angry": "They're upset. Ask what happened. Listen.",
    "resentful": "They're fed up with something. Ask what's bothering them.",
    "bored": "Ask about their interests. Suggest an activity.",
    "apathetic": "Low mood detected. Gently ask how they're really doing.",
}

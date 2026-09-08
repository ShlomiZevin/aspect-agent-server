import io

# 1) Register the current models. CLAUDE.md: never hardcode a model string that
#    is not in services/models.service.js — that list is the single source of
#    truth and is exposed via GET /api/models.
p = 'services/models.service.js'
s = io.open(p, encoding='utf-8').read()
anchor = "  { id: 'claude-opus-4-7',   providerId: 'anthropic', name: 'Claude Opus 4.7',   notes: 'Top reasoning — slow & expensive' },"
add = (
    "  { id: 'claude-opus-5',     providerId: 'anthropic', name: 'Claude Opus 5',     notes: 'Newest top reasoning — same price as 4.7' },\n"
    "  { id: 'claude-sonnet-5',   providerId: 'anthropic', name: 'Claude Sonnet 5',   notes: 'Newest balanced — same price as 4.6' },\n"
)
if 'claude-opus-5' in s:
    print('models already registered')
else:
    if anchor not in s:
        raise SystemExit('models.service anchor missing')
    s = s.replace(anchor, add + anchor, 1)
    io.open(p, 'w', encoding='utf-8', newline='').write(s)
    print('registered claude-opus-5 and claude-sonnet-5')

# 2) Point Otto at them.
p = 'otto/services/otto.service.js'
s = io.open(p, encoding='utf-8').read()
edits = [(
    "const TALK_MODEL = 'claude-sonnet-4-6';\nconst BUILD_MODEL = 'claude-opus-4-7';",
    "const TALK_MODEL = 'claude-sonnet-5';\nconst BUILD_MODEL = 'claude-opus-5';",
), (
    " * Two models on purpose: `claude-sonnet-4-6` to talk (fast, cheap, many turns)\n"
    " * and `claude-opus-4-7` to build (one call, and the quality of the artifact is\n"
    " * the whole deliverable).",
    " * Two models on purpose: `claude-sonnet-5` to talk (fast, cheap, many turns)\n"
    " * and `claude-opus-5` to build (one call, and the quality of the artifact is\n"
    " * the whole deliverable). Both are the current generation and cost the same\n"
    " * per token as the 4.x models they replace — $3/$15 and $5/$25 per million.",
), (
    "  // No `temperature` here on purpose: claude-opus-4-7 rejects the parameter\n"
    "  // outright (\"temperature is deprecated for this model\"), which fails the\n"
    "  // whole build with a 400. The talk model still takes it.",
    "  // No `temperature` here on purpose: the current Opus and Sonnet models\n"
    "  // reject the parameter outright (\"temperature is deprecated for this\n"
    "  // model\") and fail the whole call with a 400.",
)]
for i, (old, new) in enumerate(edits, 1):
    if old not in s:
        raise SystemExit(f'otto edit {i} did not match:\n{old[:110]!r}')
    s = s.replace(old, new, 1)

# Sonnet 5 rejects `temperature` too, so it has to come off the talk calls.
s = s.replace("model: TALK_MODEL, maxTokens: 900, jsonOutput: true, temperature: 0.4, context: 'otto_brainstorm',",
              "model: TALK_MODEL, maxTokens: 900, jsonOutput: true, context: 'otto_brainstorm',")
s = s.replace("model: TALK_MODEL, maxTokens: 1400, jsonOutput: true, temperature: 0.2, context: 'otto_plan',",
              "model: TALK_MODEL, maxTokens: 1400, jsonOutput: true, context: 'otto_plan',")
if 'temperature' in s:
    raise SystemExit('a temperature is still set somewhere in otto.service.js')

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('otto now on claude-sonnet-5 / claude-opus-5, no temperature anywhere')

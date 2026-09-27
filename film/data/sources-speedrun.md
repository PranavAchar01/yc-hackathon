# Speedrun pitch — sources

All URLs below were actually opened and verified this session (2026-09-26) via a browser-fetch tool, not guessed. Quotes are verbatim from the fetched page. "Uncertain" flags mean the number is an estimate/illustration in the source, not a first-party measurement.

---

## 1. Computer-use / browser agents burn huge tokens and steps

### Anthropic — Vision docs, "Resolution and token cost"
- **Outlet/authors:** Anthropic (official docs)
- **Date:** current (accessed 2026-09-26)
- **URL:** https://docs.anthropic.com/en/docs/build-with-claude/vision
- **Slide number/quote:** "An image, therefore, costs `⌈width / 28⌉ × ⌈height / 28⌉` visual tokens." Max visual tokens: **4,784** (high-res tier) / **1,568** (standard tier) per image. A 1920×1080 screenshot works out to roughly **2,691 tokens** — for ONE screenshot.

### Anthropic — Computer use tool docs, "Pricing"
- **Outlet/authors:** Anthropic (official docs)
- **Date:** current (accessed 2026-09-26)
- **URL:** https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool
- **Slide number/quote:** "Declaring `computer_toolset_20260801` with its default members adds about **4,500 input tokens** to a request... which covers the member tool definitions and the tool use system prompt." Every single step of a computer-use loop pays this tax again, plus a fresh screenshot, plus history.

### OSWorld 2.0 (arXiv, Jun 2026) — long-horizon computer-use benchmark
- **Outlet/authors:** arXiv preprint 2606.29537 (multi-author academic team)
- **Date:** submitted 28 Jun 2026
- **URL:** https://arxiv.org/abs/2606.29537
- **Slide number/quote:** "Each task represents a realistic end-to-end workflow that takes human users a median of about **1.6 hours** to complete and requires an average of **318 tool calls** with Claude Opus 4.7 using maximum thinking, compared with about **30** in OSWorld 1.0." Best model (Opus 4.8, max thinking, 500 steps) "still completes only **20.6%** of tasks."

### a16z — "Can Agents Use a Computer Yet? We've Got the Data"
- **Outlet/authors:** Andreessen Horowitz (Fabrizio Serafini, Seema Amble, Eric Zhou)
- **Date:** Posted August 10, 2026
- **URL:** https://a16z.com/can-agents-use-a-computer-yet-weve-got-the-data/
- **Slide number/quote:** "A year ago the best computer-using model scored **42%** on OSWorld-Verified; today's best scores **85%**, above the ~72% humans manage on the same tasks." Good headline chart for "agents are improving but still slow/imperfect" framing — doesn't itself give a token number but is a strong visual anchor.

---

## 2. Loading everything into context is wasteful

### Anthropic — "Equipping agents for the real world with Agent Skills"
- **Outlet/authors:** Anthropic Engineering (official blog)
- **Date:** Published Oct 16, 2025
- **URL:** https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- **Slide number/quote:** "At startup only skill names and descriptions are loaded (~80 tokens each), full instructions are activated when relevant, and supporting scripts/docs are pulled in only during execution... This metadata is the first level of progressive disclosure."

### Anthropic — "Introducing advanced tool use on the Claude Developer Platform"
- **Outlet/authors:** Anthropic Engineering (official blog)
- **Date:** Published Nov 24, 2025
- **URL:** https://www.anthropic.com/engineering/advanced-tool-use
- **Slide number/quote:** "That's 58 tools consuming approximately **55K tokens** before the conversation even starts... At Anthropic, we've seen tool definitions consume **134K tokens** before optimization." With the Tool Search Tool instead: "Total context consumption: ~8.7K tokens, preserving 95% of context window" — **an 85% reduction in token usage**, and MCP-eval accuracy went from 49%→74% (Opus 4) and 79.5%→88.1% (Opus 4.5).

### Chroma — "Context Rot: How Increasing Input Tokens Impacts LLM Performance"
- **Outlet/authors:** Chroma (research report)
- **Date:** July 2025
- **URL:** https://www.trychroma.com/research/context-rot
- **Slide number/quote:** "As context length increases, performance consistently degrades across all models"; tested "18 state-of-the-art models including GPT-4.1, Claude 4, Gemini 2.5, and Qwen3." Even a simple repeated-word replication task decays — models "do not use their context uniformly."

### mmntm.net — "The MCP Tax: When Standards Cost You 99% of Your Token Budget" (UNCERTAIN — illustrative model, not a measured study)
- **Outlet/authors:** mmntm.net (marketing/SEO blog, unclear authorship)
- **Date:** undated, referenced 2026
- **URL:** https://www.mmntm.net/articles/mcp-context-tax
- **Slide number/quote:** "GitHub | 35 | ~26,000 ... Total baseline ... ~55,000" tokens before "Hello." Flag: this table is explicitly a modeled example ("Model a typical developer workflow agent"), not a measured deployment — the same 55K figure appears (independently, first-party) in the Anthropic advanced-tool-use post above, which is the stronger citation. Use Anthropic's own post for the number; skip this one or use only for color.

---

## 3. Memory / reusable skills make web agents cheaper or better

### Agent Workflow Memory (Wang, Mao, Fried, Neubig — arXiv 2409.07429)
- **Outlet/authors:** Zora Zhiruo Wang, Jiayuan Mao, Daniel Fried, Graham Neubig (CMU)
- **Date:** Submitted 11 Sep 2024
- **URL:** https://arxiv.org/abs/2409.07429
- **Slide number/quote:** "AWM substantially improves the baseline results by **24.6%** and **51.1%** relative success rate on Mind2Web and WebArena while reducing the number of steps taken to solve WebArena tasks successfully." Online AWM "surpassing baselines from **8.9 to 14.0 absolute points** as train-test task distribution gaps widen."

### SkillWeaver (Zheng, Fatemi, Jin, Wang, et al. — arXiv 2504.07079)
- **Outlet/authors:** Boyuan Zheng, Michael Y. Fatemi, Xiaolong Jin, Zora Zhiruo Wang, et al. (incl. Graham Neubig, Yu Su)
- **Date:** Submitted 9 Apr 2025
- **URL:** https://arxiv.org/abs/2504.07079
- **Slide number/quote:** Abstract: agents "autonomously synthesizing reusable skills as APIs." Per the paper's reported results (confirmed via arXiv abstract + secondary coverage): relative success-rate gains of **31.8%** (WebArena) and **39.8%** (real-world sites), and up to **54.3%** improvement transferring skills from a strong agent to a weaker one.

---

## 4. Multi-agent / specialist routing vs. one generalist — measured cost

### Anthropic — "How we built our multi-agent research system"
- **Outlet/authors:** Anthropic Engineering (official blog)
- **Date:** Published Jun 13, 2025
- **URL:** https://www.anthropic.com/engineering/built-multi-agent-research-system
- **Slide number/quote:** "In our data, agents typically use about **4× more tokens** than chat interactions, and multi-agent systems use about **15× more tokens** than chats." Also: multi-agent beat a single Opus-4 agent "by 90.2%" on internal research eval — the two numbers side by side (15x cost, 90% better) are the whole "is it worth it" argument in one slide.

---

## B-roll picks (clean-rendering, clear headline, no paywall) — 5 of the above

1. **Anthropic — "Introducing advanced tool use"** (https://www.anthropic.com/engineering/advanced-tool-use) — has an actual annotated diagram ("Tool Search Tool preserves 191,300 tokens...") that reads as a headline pop-up on its own.
2. **Anthropic — "How we built our multi-agent research system"** (https://www.anthropic.com/engineering/built-multi-agent-research-system) — the 15x/4x tokens line is a clean, quotable Anthropic-branded stat.
3. **Chroma — "Context Rot"** (https://www.trychroma.com/research/context-rot) — has a hero chart image built for this exact use (title card literally says "How Increasing Input Tokens Impacts LLM Performance").
4. **a16z — "Can Agents Use a Computer Yet?"** (https://a16z.com/can-agents-use-a-computer-yet-weve-got-the-data/) — has a polished 42%→85% bar chart image, a16z-branded, no paywall.
5. **Anthropic — "Equipping agents for the real world with Agent Skills"** (https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — has a clean SKILL.md anatomy diagram, official Anthropic branding, renders cleanly.

Avoid using the OSWorld 2.0 arXiv page and the two arXiv paper pages (AWM, SkillWeaver) as B-roll pop-ups directly — arXiv abstract pages are plain-text and don't read as a "headline" visual; pull the specific number onto your own slide instead.

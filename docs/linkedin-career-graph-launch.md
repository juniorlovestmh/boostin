# LinkedIn career graph launch

This is a human-controlled campaign. Boostin schedules measurement and imports
first-party files. It does not publish, comment, react, message, or open
LinkedIn.

## Launch post

```text
I exported nine years of my LinkedIn posts and graphed them.

The result explained why I ended up in AI Revenue Operations.

The through-line was not a specific tool or title. It was removing friction between people, systems, and business outcomes:

Global customer access
-> Accessibility
-> Revenue operations
-> AI enablement
-> Agent systems and harness engineering

The analysis also showed me where my public positioning is weak.

I had written about HubSpot more often than the RevOps discipline behind it. I had done substantial enablement work without writing about it explicitly. My archive had no mention of agent harnesses, even though agent systems are now a meaningful part of what I build.

I wrote up the local-first workflow, the export schema drift, the writing changes, the career graph, and the privacy boundary here:

https://appheat.co/posts/i-graphed-nine-years-of-linkedin-posts/

What thread appears when you look across your own career?
```

The article link belongs in the post body. Do not move it to a comment. The
campaign is optimizing for qualified readers and attributable article visits,
not for a speculative reach trick.

## Before publishing

1. Review the AppHeat article and public graph for privacy and evidence.
2. Confirm the article is published at its canonical URL.
3. Publish the LinkedIn post through LinkedIn's native interface.
4. Copy the LinkedIn post URL.
5. Start the campaign:

```sh
boostin campaign start \
  --slug linkedin-career-graph \
  --article-url https://appheat.co/posts/i-graphed-nine-years-of-linkedin-posts/ \
  --post-url <linkedin-post-url> \
  --published-at <ISO-8601-with-offset>
```

## Measurement checkpoints

At 24 hours, 72 hours, 7 days, and 30 days:

1. Download LinkedIn's Combined Post Analytics workbook.
2. Put it in `~/Library/Application Support/Boostin/inbox/`.
3. Record a profile snapshot if the values are available.
4. Process the inbox with the real capture time.
5. Mark the checkpoint complete with that same capture time.
6. Record qualified conversation counts without contact details.

```sh
boostin inbox process --captured-at <ISO-8601-with-offset>

boostin snapshot profile \
  --captured-at <ISO-8601-with-offset> \
  --followers <count> \
  --profile-views <count> \
  --search-appearances <count>

boostin checkpoint complete \
  --campaign linkedin-career-graph \
  --name <24h|72h|7d|30d> \
  --captured-at <ISO-8601-with-offset>

boostin report campaign \
  --slug linkedin-career-graph \
  --private \
  --out ~/Documents/linkedin-career-graph-private-report.md
```

Do not combine the measurements into a single growth score and do not claim
that the post caused a conversation. Treat outcomes as self-reported signals.

## Follow-up

At 7 days, publish a new graph insight rather than reposting the same article.
After two to three weeks of dogfood evidence, adapt
`docs/appheat-draft.mdx` into the technical follow-up on Boostin's local-first
architecture and campaign loop.

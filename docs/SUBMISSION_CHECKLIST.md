# Submission checklist

Deadline: **Thu 12 Nov 2026, 12:00 pm Pacific = 13 Nov, 1:30 am IST.** Judging runs until **15 Dec 2026**, so keep these working until then: the Render service, the PayPal sandbox app and its keys, the Gemini key, the sandbox buyer password, and the public YouTube video and repo.

## Day 1: make it real
- [ ] Create a PayPal sandbox app; put the Client ID and Secret in `.env`.
- [ ] Enable **Payouts** for the sandbox app.
- [ ] Create a second sandbox Personal account to be the freelancer.
- [ ] Add `GEMINI_API_KEY` (free, aistudio.google.com) to `.env`.
- [ ] `npm start` and run the whole demo once in sandbox mode.
  - The hold appears in the buyer's sandbox account.
  - The payout reaches the freelancer's sandbox account.
- [ ] `npm test` passes.

## Repository (required)
- [ ] Public GitHub repo containing all source code.
- [ ] `LICENSE` (MIT) at the root. GitHub must show "MIT license" in the repo's **About** sidebar. If it doesn't, refresh after the first push.
- [ ] Optionally replace "Verdict contributors" in `LICENSE` with your name or team.
- [ ] Add a short repo description and the hosted demo URL in **About**.
- [ ] `.env` is NOT committed (it's in `.gitignore`).

## Functional demo (required: repo instructions OR hosted URL; do both)
- [ ] Deploy to Render with `render.yaml` and set the three secret env vars.
- [ ] Open the hosted URL in a private window and run the demo end to end.
- [ ] Put sandbox buyer credentials in the Devpost testing instructions.

## Video (required)
- [ ] Under 3:00. Shows the project working end to end on the device it was built for (web browser).
- [ ] No copyrighted music. No third-party logos other than PayPal's own checkout UI.
- [ ] Uploaded to YouTube as Public; link in the submission form.

## Devpost form
- [ ] Text description: paste from `docs/DEVPOST.md`.
- [ ] Tools section: name Gemini and the exact PayPal APIs, and explain how each is used (already in `docs/DEVPOST.md`).
- [ ] Screenshots: home page, criteria drafted, Held ruling with fix notes, Released ruling, injection warning.
- [ ] Built-with tags.
- [ ] Submit, then reopen the page to confirm it shows as submitted.

## Prizes this project targets
- Grand prizes, plus the honorable mentions *Best Use of PayPal + AI*, *Most Creative* and *Best Demo Delivery*.
- **Best Use of Render** (sponsor prize): eligible because the demo runs on Render. A project can win one grand or honorable-mention prize plus one sponsor prize.

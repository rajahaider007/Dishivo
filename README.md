# Dishivo — Flipdish Capture Bot

Logs into the Flipdish portal, captures screenshots of key screens, extracts page details, and writes an organized client-requirements pack under `output/`.

## Setup

```bash
npm install
```

Copy `.env.example` → `.env` and fill credentials (never commit `.env`).

## Run

```bash
npm run capture
```

Browser opens headed (required — Flipdish login has **hCaptcha**).

1. Bot fills email (and password when the step appears)
2. **You** tick “I am human” / solve captcha and click Continue
3. After portal loads, bot auto-captures all sections
4. Session is saved to `.auth/` so the next run often skips login

## Output

```
output/<timestamp>/
  screenshots/     # full-page PNGs per section
  details/         # JSON + text extracts
  REPORT.md        # organized client requirements summary
  INDEX.json       # machine-readable index of all captures
```

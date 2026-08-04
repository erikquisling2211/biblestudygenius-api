# BibleStudyGenius API

Backend for BibleStudyGenius — syncs per-user data (highlights, Scripture IQ,
reading progress, settings) keyed to Clerk identity.

## Environment variables (set in Railway)
- DATABASE_URL — provided automatically by Railway Postgres
- CLERK_SECRET_KEY — from Clerk dashboard, the sk_ key
- PORT — provided automatically by Railway

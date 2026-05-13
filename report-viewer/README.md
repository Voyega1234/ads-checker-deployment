# Ad Compliance Report Viewer

Static Vercel viewer for ad compliance reports.

Open a report with:

```text
/report-viewer.html?report=<public-report-json-url>
```

This folder intentionally contains no `.env`, no API keys, and no report data. The viewer fetches a public report JSON URL passed in the query string.

Resolved issue state is stored through the Vercel API route at `/api/issue-states`.
The browser never receives a Supabase service key.

Required Vercel environment variables for shared resolved state:

```text
SUPABASE_URL=<project-url>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

Create the database table with:

```sql
-- report-viewer/sql/ad_compliance_issue_states.sql
```

Deploy:

```bash
npx vercel@latest --prod --yes
```

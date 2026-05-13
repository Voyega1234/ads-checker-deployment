# Report Viewer Deployment

The live report viewer still lives in the existing root-level `report-viewer`
folder. Keep it there until the worker wrapper is stable.

Deploy:

```bash
production/scripts/deploy-report-viewer.sh
```

Production URL:

```txt
https://report-viewer-theta.vercel.app/report-viewer
```

The viewer should not contain Meta, Gemini, Slack, or Supabase service-role
secrets. It only needs public report JSON URLs and the resolved-state API env
configured in Vercel.

import dotenv from "dotenv";

dotenv.config({ path: ".env", override: true });

aliasEnv("SUPABASE_URL", "VITE_SUPABASE_URL");
aliasEnv("SUPABASE_SERVICE_KEY", "VITE_SUPABASE_SERVICE_KEY");
aliasEnv("SLACK_BOT_TOKEN", "SLACK_BOT_OAUTH");

function aliasEnv(target, source) {
  if (process.env[target]) return;
  const value = process.env[source];
  if (value) process.env[target] = value;
}

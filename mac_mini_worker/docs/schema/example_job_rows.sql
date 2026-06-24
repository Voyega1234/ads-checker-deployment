insert into public.macmini_worker_jobs (
  job_source,
  input_json,
  metadata_json
) values (
  'slack_alert',
  jsonb_build_object(
    'caption', 'ตัวอย่างข้อความโฆษณาสำหรับตรวจ policy และ spelling'
  ),
  jsonb_build_object(
    'client_id', 'Example Client',
    'account_id', 'act_1234567890',
    'source', 'workflow'
  )
);

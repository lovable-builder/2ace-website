// Which backend this copy of the site talks to. Every page loads this first, before any other script, and reads window.ACE_CONFIG.
// The anon key is public by design: row-level security in the database protects the data.
// staging.<domain> uses the staging project. Until its values are filled in below, staging pages stop here instead of
// silently writing to the live database.
(function () {
  var ENVS = {
    production: {
      supabaseUrl: 'https://hvbcmilcjragrcezwzlo.supabase.co',
      supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh2YmNtaWxjanJhZ3JjZXp3emxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEwNjMyODMsImV4cCI6MjEwNjYzOTI4M30.Q6TlQnDToz2oPr4FXNgKdgdrZT3ojUToCroLRVQGRsw',
      // Error reports (Sentry). Empty = off. The DSN is public by design, like the anon key.
      sentryDsn: ''
    },
    staging: {
      supabaseUrl: '',
      supabaseAnonKey: '',
      sentryDsn: ''
    }
  };
  var name = /^staging\./i.test(location.hostname) ? 'staging' : 'production';
  var c = ENVS[name];
  if (!c.supabaseUrl || !c.supabaseAnonKey) throw new Error('config.js: the ' + name + ' backend is not configured');
  var ref = (/^https:\/\/([a-z0-9-]+)\./i.exec(c.supabaseUrl) || [])[1] || 'local';
  window.ACE_CONFIG = Object.freeze({
    env: name,
    supabaseUrl: c.supabaseUrl,
    supabaseAnonKey: c.supabaseAnonKey,
    sentryDsn: c.sentryDsn,
    // supabase-js keeps the session under this key; every page reads the same one.
    authStorageKey: 'sb-' + ref + '-auth-token'
  });
})();

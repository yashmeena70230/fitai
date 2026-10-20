FitAI GitHub upload
===================

Prepared copy: C:\Users\yash meena\Documents\Codex\2026-10-20\i-a\outputs\fitai-github-upload
Target repository: https://github.com/yashmeena70230/fitai

The prepared copy contains the complete app source/configuration and a safe .env.example template. Its OPENAI_API_KEY value is blank. It does not contain the original workdata SQLite database, secrets, or passwords. This is a public repository: anything committed will be visible to everyone. Never add .env, database files, user exports, passwords, or API keys.

Safest upload route (adds FitAI in its own folder on a branch)
-------------------------------------------------------------
These commands preserve existing repository files. They clone the existing repo, create a new branch, and put the app in a new subfolder named fitai-github-upload. If that folder already exists in the repo, stop and choose another unused subfolder name before copying.

Before uploading, install Git for Windows and Node.js 24 if they are not already installed. This app has no third-party packages to install; local checks can run directly with `node scripts/build.mjs` and `node --test`.

1. Open PowerShell and run:

   git clone https://github.com/yashmeena70230/fitai.git fitai-repo-upload
   Set-Location .\fitai-repo-upload
   git switch -c add-fitai-web-app
   if (Test-Path .\fitai-github-upload) { throw 'fitai-github-upload already exists; choose an unused folder name to prevent overwrites.' }
   New-Item -ItemType Directory -Path .\fitai-github-upload | Out-Null

2. Copy the prepared files. Change $source only if the prepared folder is at a different location:

   $source = 'C:\Users\yash meena\Documents\Codex\2026-10-20\i-a\outputs\fitai-github-upload'
   Copy-Item -LiteralPath @("$source\.gitignore", "$source\.env.example", "$source\GITHUB_UPLOAD_README.txt", "$source\package.json", "$source\README.md", "$source\render.yaml", "$source\server.js") -Destination .\fitai-github-upload
   Copy-Item -LiteralPath @("$source\public", "$source\scripts", "$source\test") -Destination .\fitai-github-upload -Recurse

3. Review what will be uploaded before committing:

   git status --short
   git add -- fitai-github-upload
   git diff --cached --name-only
   git status --short

   Confirm the staged list contains app code/assets/config/docs only. It should not contain .env (the safe .env.example is okay), workdata, data, SQLite/database files, node_modules, logs, API keys, passwords, or private user data. If anything unexpected appears, stop and unstage it with `git restore --staged -- fitai-github-upload` before committing.

4. Commit and push only this new branch, then open a pull request in GitHub and inspect it before merging:

   git commit -m "Add FitAI web app"
   git push -u origin add-fitai-web-app

   Do not use `git push --force`. No GitHub upload has been performed by this preparation.

Deploying the app
-----------------

The app uses Node.js 24, includes its own frontend and backend in one Node service, and persists accounts in a SQLite database. GitHub Pages cannot run the Node backend, so do not deploy this as a static-only site.

The included render.yaml is configured for Render and sets the service root directory to `fitai-github-upload`, matching the safe subfolder above. After the branch is merged (or when you choose to deploy that branch), in Render choose New > Blueprint, connect this repository/branch, and set the Blueprint Path to `fitai-github-upload/render.yaml`. Review the plan and any disk charges before creating the service. The Blueprint's build/start commands are `node scripts/build.mjs` and `node server.js`; it mounts the SQLite database directory at `/opt/render/project/src/data` and sets DATA_DIR there. Keep the persistent disk attached and do not point DATA_DIR at temporary storage.

Add OPENAI_API_KEY in the Render service's Environment settings as a secret only if you want the live AI Coach. Never paste it into GitHub, render.yaml, or browser code. No API key is included here. HTTPS is provided by the host after successful deployment; this app has not been deployed and no live URL has been verified.

Free hosting: Render's free web service can run Node but uses an ephemeral filesystem. SQLite data can be lost on restarts, deploys, or idle spin-downs, so it is not safe for persistent FitAI user data. The included disk-backed Render configuration uses a paid service/disk. A no-cost production setup would require changing the app from local SQLite to a durable hosted database and verifying that provider's current free limits. See Render's current limits: https://render.com/docs/free and persistent disk details: https://render.com/docs/disks.

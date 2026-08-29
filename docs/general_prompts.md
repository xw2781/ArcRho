26/8/27

# Set model to Opus 4.8 (1M context) for a session
/model claude-opus-4-8[1m]

# Commit and Push Workflow

git pull --ff-only

You're on a detached HEAD with ??? modified files and nothing stashed. To throw all of that away and match the remote's main:

git fetch origin
git checkout -f main
git reset --hard origin/main
git clean -fd

- fetch pulls down the updated remote history.
- checkout -f main moves you off the detached HEAD and discards the tracked-file edits.
- reset --hard origin/main points your local main exactly at the remote.
- clean -fd deletes untracked files and folders that were left behind. Add -x too if you also want ignored files (build output, venvs, local config) removed — but that will wipe things like local .env files and cached tool installs, so leave -x off unless you really want a bare tree.
If you'd rather not touch this working copy at all, just clone it fresh next to it: git clone https://github.com/xw2781/ArcRho.git ArcRho-fresh.

Run the commit workflow.

[$arcrho-commit-workflow](E:\\XWSpace\\Repos\\ArcRho\\.claude\\skills\\arcrho-commit-workflow\\SKILL.md)

# JSON Contract Validations

Macros
"Import ResQ Reserving Class"
"Export Reserving Class to ResQ"
"Sync Reserving Class with ResQ"


Project: NJ_Annual_Prod_202605_Fake
Path: PRNJ - PA\PA\All States\Direct Group\COL

Project: NJ_Annual_Prod_202605_Fake
Path: HPPREF\HO+DF\NJ\Legacy\HOL

# Server Components Rebuild and Deploy
commit, rebuild and deploy server components
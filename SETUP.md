# netpulse — GHCR setup guide

Your original `docker-compose.yml` used `build: .`, which only works when you run
`docker compose up` by hand. The ZimaOS App Store installer can only **pull** a
ready-made image from a registry — it can't build one. That's why your install
stalled at 5% "looking for repository": it was trying to `docker pull netpulse:latest`,
which doesn't exist anywhere.

This package fixes that by having **GitHub Actions** build the image for you in the
cloud and push it to **GHCR** (GitHub Container Registry), every time you push code.
After that, ZimaOS can pull it like any other app.

## One-time setup (10 minutes)

### 1. Create a GitHub repository
- Go to github.com → **New repository**
- Name it `netpulse` (or anything you like — just remember it)
- Keep it **Public** (simplifies pulling the image later — private also works but needs extra auth on the ZimaOS side)
- Don't initialize with a README (we already have one)

### 2. Upload these files to the repo
Easiest way — no git command line needed:
- On your new repo's GitHub page, click **"uploading an existing file"**
- Drag in this entire folder's contents, **keeping the folder structure**:
  ```
  .github/workflows/build-and-push.yml
  backend/
  frontend/
  Dockerfile
  docker-compose.yml
  docker-compose.bridge.yml
  README.md
  ```
- Commit directly to `main`

(If you're comfortable with git, this is equally just: `git init`, `git add .`, `git commit -m "initial"`, `git remote add origin <your-repo-url>`, `git push -u origin main`.)

### 3. Watch it build
- Go to the **Actions** tab on your GitHub repo
- You should see a workflow run start automatically ("Build and push netpulse image")
- It takes 2–5 minutes to build for both amd64 and arm64
- Green checkmark = success, image is now pushed to GHCR

### 4. Make the package public
By default, a freshly pushed GHCR image is **private**, and ZimaOS won't be able to pull
it without extra credentials. Make it public:
- Go to your GitHub profile → **Packages** tab
- Click on the `netpulse` (or your repo name) package
- On the right sidebar, **Package settings** → scroll to **Danger Zone** → **Change visibility** → **Public**

### 5. Update docker-compose.yml with your real image name
Open `docker-compose.yml` (and `docker-compose.bridge.yml` if you plan to use bridge mode)
and replace:
```
image: ghcr.io/YOUR_GITHUB_USERNAME/YOUR_REPO_NAME:latest
```
with your actual values, e.g.:
```
image: ghcr.io/janedoe/netpulse:latest
```

### 6. Install in ZimaOS
- In ZimaOS, use **Install a customized app** (or whatever your version calls the
  "install from compose file" option)
- Paste in the corrected `docker-compose.yml`
- It should now pull cleanly from GHCR instead of stalling

## Future updates
Any time you change `backend/`, `frontend/`, or the `Dockerfile` and push to `main`,
GitHub Actions automatically rebuilds and re-pushes `:latest`. In ZimaOS you'd then
just re-pull / recreate the container to pick up the new image (most ZimaOS versions
have an "Update" button on the app once a newer image is detected, or you can force it
via the app's settings → save/restart).

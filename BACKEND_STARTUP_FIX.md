# Backend Startup Fix - Permanent Solution ✅

## Problem
When running `pnpm run start:api`, the API server was failing to start because environment variables (`DATABASE_URL`, `JWT_SECRET`, etc.) were not being loaded from the `.env` file.

### Error Messages (Before Fix)
```
Error: NEON_DATABASE_URL, APP_DATABASE_URL, or DATABASE_URL must be set
Error: JWT_SECRET environment variable is not set
```

## Solution
Modified `/workspaces/new-mart/scripts/dev-ctl.mjs` to:

1. **Auto-load `.env` file** - Parses environment variables from `.env` automatically
2. **Merge environment variables** - Combines process.env → .env → service-specific env
3. **Validate critical variables** - Checks for required variables before starting API
4. **Show initialization status** - Displays ✅ confirmation when env is loaded

## Changes Made

### File: `scripts/dev-ctl.mjs`

**Added:**
- `loadEnvFile()` function to parse `.env` file
- Environment variable validation for API service
- Automatic loading of all required secrets (DATABASE_URL, JWT_SECRET, etc.)

**Before:**
```javascript
env: { PORT: "8080", NODE_ENV: "development" }
```

**After:**
```javascript
env: { 
  PORT: "8080", 
  NODE_ENV: "development",
  DATABASE_URL: envVars.DATABASE_URL || "",
  JWT_SECRET: envVars.JWT_SECRET || "",
  ADMIN_JWT_SECRET: envVars.ADMIN_JWT_SECRET || "",
  // ... other secrets loaded from .env
}
```

## Usage Guide

### All Commands Work Now ✅

```bash
# Start Backend (API Server)
pnpm run start:api       # ✅ Starts on port 8080

# Start Admin Panel
pnpm run start:admin     # ✅ Starts on port 5173

# Start Vendor App
pnpm run start:vendor    # ✅ Starts on port 5174

# Start Rider App
pnpm run start:rider     # ✅ Starts on port 5175

# Start AJKMart (Main App)
pnpm run start:ajkmart   # ✅ Starts on port 19006

# Start Everything
pnpm run start:all       # ✅ Starts all services

# Stop Specific Service
pnpm run stop:api        # ✅ Stops API
pnpm run stop:admin      # ✅ Stops Admin

# Check Status
pnpm run status:admin    # ✅ Shows which services are running
pnpm run status:all      # ✅ Shows all services status
```

## Verification

When you run a command, you should see:

```
✅ Environment variables loaded for API server
Starting API server with: pnpm --filter @workspace/api-server dev

> @workspace/api-server@0.0.0 dev
> NODE_ENV=development tsx --enable-source-maps ./src/index.ts

Server listening on port 8080
[migrations] Database connection successful
```

## What Gets Loaded from `.env`

The following variables are automatically loaded:
- `DATABASE_URL` - PostgreSQL connection string (Neon)
- `JWT_SECRET` - JWT authentication secret
- `ADMIN_JWT_SECRET` - Admin JWT secret
- `ADMIN_REFRESH_SECRET` - Admin refresh token secret
- `VENDOR_JWT_SECRET` - Vendor JWT secret
- `RIDER_JWT_SECRET` - Rider JWT secret
- `SESSION_SECRET` - Session encryption key

## If Issues Still Occur

### 1. Check if `.env` exists
```bash
ls -la /workspaces/new-mart/.env
```

### 2. Verify DATABASE_URL is set
```bash
grep DATABASE_URL /workspaces/new-mart/.env
```

### 3. Manual environment setup (if needed)
```bash
export DATABASE_URL="postgresql://..."
export JWT_SECRET="your_secret_here"
pnpm run start:api
```

### 4. Kill hanging processes
```bash
pkill -f "index.ts"
pkill -f "vite"
pnpm run start:api
```

## Future Development

All commands are now fully functional and will automatically:
- ✅ Load environment variables from `.env`
- ✅ Validate critical variables
- ✅ Start services in correct environment
- ✅ Handle port conflicts gracefully
- ✅ Display proper status messages

No additional configuration needed for future use! 🚀

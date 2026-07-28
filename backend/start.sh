#!/bin/sh
# Update yt-dlp on every start — maintainers ship near-daily patches to
# counter YouTube's changing bot-detection, so a build-time-only install
# goes stale fast on a service that sleeps/wakes (Render free tier).
echo "Updating yt-dlp..."
pip3 install --break-system-packages -U yt-dlp || echo "yt-dlp update failed, continuing with existing version"

exec node server.js
#!/bin/sh
# Downloads this example's source media from Frameo (project "Famous and Iconic Photos").
cd "$(dirname "$0")/src" || exit 1
curl -sfo solvay.png https://content.dashtoon.ai/user-uploaded-files/4a12c692-8d73-414a-b5a9-0414c80ced8c.png
curl -sfo money_01.png https://content.dashtoon.ai/stability-images/b187a840-caa6-42e6-846c-31e8c78c37d5.png
curl -sfo punch_title.webm https://content.dashtoon.ai/dash-references/hyperframes_1791451711_534e58ef.webm
curl -sfo original_render.mp4 https://content.dashtoon.ai/saved-videos/raw-ffmpeg/ffmpeg_3775426/66781cf600984f6a91073ef737a779fb/demo_punch_title_v4.mp4

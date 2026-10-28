#!/bin/sh
# Downloads the Frameo renders these examples are checked against
# (project "HF Motion Studio Test", module "A Type & Vector").
cd "$(dirname "$0")/src" || exit 1
B=https://content.dashtoon.ai/dash-references
curl -sfo a1_iconic.mp4 $B/hyperframes-8ed749ce5453e735da3fc8f6714d6e984be53e97.mp4
curl -sfo a2_1965.mp4   $B/hyperframes-3e537153f98075f0dc26feaf9a7401ad696fb6ef.mp4
curl -sfo a3_words.mp4  $B/hyperframes-4d2fc82c4b89dfdbf0a839c60d5df958f7e94cc7.mp4
curl -sfo a5_solvay.mp4 $B/hyperframes-8cd1c4a51537ed3e0400fb0ac8e0e02961d0e789.mp4
curl -sfo a4_sweep.mp4     $B/hyperframes-c93f1b7b6a30c9c40cc680bfdf3ce3a7f459085c.mp4
curl -sfo a6_shapes.mp4    $B/hyperframes-048a2580ca9f6d1468dc50969f528b92acb3e670.mp4
curl -sfo a7_gradients.mp4 $B/hyperframes-a1b983ff806e8c618280f0167d2d07966db67dcd.mp4
curl -sfo a8_paintpath.mp4 $B/hyperframes-4e5685e91c670501d74d3ad2c80db3c695cfc4e6.mp4
curl -sfo a10_eases.mp4    $B/hyperframes-7355c63e69deb78e77c0eb61db7266d9e5a74000.mp4
curl -sfo e1_expr.mp4       $B/hyperframes-c141d9e4e06e052c1cfc937d6f65409454c9251c.mp4
curl -sfo w1_whipflash.mp4  $B/hyperframes-921eea305d61e6be6e51d20a768b9af7fa4292d6.mp4
curl -sfo w2_domwhip.mp4    $B/hyperframes-f8094ecb7cdc9ce4678d85b5adae2a8684f91d60.mp4
curl -sfo x1_dirwhip.mp4    $B/hyperframes-dfc875777f57934628744d7bfb878d6d921dddec.mp4
curl -sfo x2_cutdistort.mp4 $B/hyperframes-9f1f24700bccbae513016c4070d35e7a152938b2.mp4
curl -sfo p1_particles.mp4  $B/hyperframes-1088b846282c3fc77c2bff4c0e85180ba1ab567b.mp4

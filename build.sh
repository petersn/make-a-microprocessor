
set -x

APP_DIR=.

# Rebuild pkg/*
wasm-pack build --target web

# Copy the build into the example application.
mkdir -p $APP_DIR/src/wasm-build
cp pkg/libsnpspice.js $APP_DIR/src/wasm-build/libsnpspice.js
cp pkg/libsnpspice_bg.wasm $APP_DIR/public/

# Currently wasm-pack is using some future import.meta feature I don't have.
sed -i "s/^.*import[.]meta.*$/\/\/ Line deleted./" $APP_DIR/src/wasm-build/libsnpspice.js


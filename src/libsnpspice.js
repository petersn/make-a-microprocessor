// libsnpspice

import init, {
    generate_number,
} from "./wasm-build/libsnpspice_wasm_interface.js";

export let isInitialized = false;
export let initializationPromise = init(process.env.PUBLIC_URL + "/libsnpspice_bg.wasm")
    .then(() => isInitialized = true);

function assertIsInitialized() {
    if (isInitialized === false) {
        throw "libsnpspice is not initialized -- please await libsnpspice.initializationPromise, or make sure that libsnpspice.isInitialized === true";
    }
}

export function getValue() {
    assertIsInitialized();
    return generate_number();
}

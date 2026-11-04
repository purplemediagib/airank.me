// Offline test runner only. This directory is never copied into the image.
import {register} from 'node:module';
register('./fixture-loader.mjs',import.meta.url);

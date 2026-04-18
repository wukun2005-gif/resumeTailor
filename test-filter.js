import { isExportedDigestArtifactFileName, getLibraryDigest } from './server/services/libraryCache.js';
import fs from 'fs';

console.log('Written Essay.txt', isExportedDigestArtifactFileName('Written Essay.txt'));

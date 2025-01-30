// test/audio-converter.test.js
import tap from 'tap';
import { pcm24To16 } from '../lib/audio-converter.js';

// Helper function to create a buffer with a specific pattern
function createTestBuffer(length) {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 2) {
    buffer.writeInt16LE(i / 2, i);
  }
  return buffer;
}

tap.test('pcm24To16 should convert 24kHz PCM to 16kHz PCM', (t) => {
  const inputBuffer = createTestBuffer(960); // 20ms frame at 24kHz
  const expectedOutputLength = Math.floor(inputBuffer.length * 2 / 3);

  const outputBuffer = pcm24To16(inputBuffer);

  t.equal(outputBuffer.length, expectedOutputLength, 'Output buffer length should be correct');

  // Check if the first and third samples are copied correctly
  t.equal(outputBuffer.readInt16LE(0), inputBuffer.readInt16LE(0), 'First sample should match');
  t.equal(outputBuffer.readInt16LE(2), inputBuffer.readInt16LE(4), 'Third sample should match');

  t.end();
});

tap.test('pcm24To16 should throw an error for invalid buffer length', (t) => {
  const invalidBuffer = createTestBuffer(950); // Not a multiple of 960

  t.throws(() => {
    pcm24To16(invalidBuffer);
  }, new Error('Invalid input buffer length. Must be multiple of 960 bytes'), 'Should throw error for invalid buffer length');

  t.end();
});
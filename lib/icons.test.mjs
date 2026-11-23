import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ICON_MAX_BYTES, iconFile, iconType, sniffImage } from './icons.mjs'

test('icons are sniffed by magic bytes; svg and junk are refused', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    assert.deepEqual(sniffImage(png), { ext: 'png', type: 'image/png' })
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext, 'jpg')
    assert.equal(sniffImage(Buffer.from('GIF89a\0\0'))?.ext, 'gif')
    assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.ext, 'webp')
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), null)
    assert.equal(sniffImage(Buffer.alloc(0)), null)
    assert.ok(ICON_MAX_BYTES > 0)
})

test('stored icon names carry no path and map back to a content type', () => {
    assert.equal(iconFile(7, 'png', 123), '7-123.png')
    assert.equal(iconType('7-123.png'), 'image/png')
    assert.equal(iconType('7-123.jpg'), 'image/jpeg')
    for (const bad of ['../7-1.png', '7-1.svg', '7-1.png/x', 'a-1.png', '', null]) assert.equal(iconType(bad), null)
})

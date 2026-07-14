from core import dpapi


def test_protect_unprotect_roundtrip():
    data = b"hello, world"
    blob = dpapi.protect(data)
    assert blob != data  # not plaintext (or fallback-prefixed on non-Windows)
    got = dpapi.unprotect(blob)
    assert got == data


def test_binary_roundtrip():
    data = bytes(range(256))
    assert dpapi.unprotect(dpapi.protect(data)) == data


def test_unicode_roundtrip():
    data = "sécret with unicode: 汉字".encode("utf-8")
    assert dpapi.unprotect(dpapi.protect(data)) == data

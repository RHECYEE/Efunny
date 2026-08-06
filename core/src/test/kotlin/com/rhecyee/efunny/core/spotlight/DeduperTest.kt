package com.rhecyee.efunny.core.spotlight

import com.rhecyee.efunny.core.model.RawPost
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DeduperTest {

    private val deduper = Deduper()
    private val now = Instant.parse("2026-08-06T12:00:00Z")

    private fun post(id: String, title: String, permalink: String = "https://example.com/$id") =
        RawPost(1, id, title, permalink, now, 1.0)

    private fun seen(vararg posts: RawPost) = posts.map { deduper.fingerprint(it) }

    @Test
    fun `catches a repost that only added an emoji and changed a stopword`() {
        val original = post("a", "Local man discovers one weird trick to avoid doing the dishes")
        val repost = post("b", "Local man discovers a weird trick to avoid doing the dishes 😂😂")

        assertTrue(deduper.isDuplicate(repost, seen(original)))
    }

    @Test
    fun `catches the same post by external id even when titles differ`() {
        val original = post("abc123", "One title")
        val renamed = post("abc123", "A completely different headline entirely")

        assertTrue(deduper.isDuplicate(renamed, seen(original)))
    }

    @Test
    fun `catches the same permalink under a different id`() {
        val original = post("a", "Some joke about cats", permalink = "https://example.com/shared")
        val duplicate = post("b", "Different words here entirely", permalink = "https://example.com/shared")

        assertTrue(deduper.isDuplicate(duplicate, seen(original)))
    }

    @Test
    fun `leaves genuinely different posts alone`() {
        val a = post("a", "Local man discovers one weird trick to avoid doing the dishes")
        val b = post("b", "Scientists confirm that cats have been plotting this all along")

        assertFalse(deduper.isDuplicate(b, seen(a)))
    }

    @Test
    fun `does not collapse two short unrelated titles`() {
        // Below the fuzzy-matching floor, only exact matches count -- otherwise
        // "lol" and "lmao" would read as the same post.
        val a = post("a", "lol")
        val b = post("b", "lmao")

        assertFalse(deduper.isDuplicate(b, seen(a)))
    }

    @Test
    fun `nothing is a duplicate of an empty history`() {
        assertFalse(deduper.isDuplicate(post("a", "Anything at all goes here"), emptyList()))
    }

    @Test
    fun `a rewritten headline sharing a few words is not a duplicate`() {
        val a = post("a", "My cat knocked a glass of water onto my brand new laptop today")
        val b = post("b", "My dog ate the last slice of pizza while I was answering the door")

        assertFalse(deduper.isDuplicate(b, seen(a)))
    }
}

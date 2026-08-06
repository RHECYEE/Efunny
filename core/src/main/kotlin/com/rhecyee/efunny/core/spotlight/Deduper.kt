package com.rhecyee.efunny.core.spotlight

import com.rhecyee.efunny.core.model.RawPost

/** A cheap, storable identity for a post, used for both dedup passes. */
data class PostFingerprint(
    val externalId: String,
    val permalink: String,
    val tokens: Set<String>,
)

/**
 * Collapses the same joke appearing twice.
 *
 * Two passes need this, for different reasons:
 *  - *within a drop*, because the same meme genuinely is cross-posted to
 *    r/funny and r/memes within minutes;
 *  - *across drops*, because every drop looks back a full 24 hours, so without
 *    it the 20:00 set would be largely a rerun of the 15:00 set.
 */
class Deduper(private val threshold: Double = 0.8) {

    fun fingerprint(post: RawPost): PostFingerprint = PostFingerprint(
        externalId = post.externalId,
        permalink = post.permalink.trim().lowercase(),
        tokens = tokenize(post.title),
    )

    fun isDuplicate(candidate: RawPost, against: Collection<PostFingerprint>): Boolean {
        if (against.isEmpty()) return false
        val fp = fingerprint(candidate)
        return against.any { seen -> matches(fp, seen) }
    }

    private fun matches(a: PostFingerprint, b: PostFingerprint): Boolean {
        if (a.externalId.isNotEmpty() && a.externalId == b.externalId) return true
        if (a.permalink.isNotEmpty() && a.permalink == b.permalink) return true

        // Short titles carry too little signal for fuzzy matching -- "lol" vs
        // "lol" would collapse two unrelated posts. Below the floor, identity is
        // exact-match only, which the checks above already covered.
        if (a.tokens.size < MIN_TOKENS_FOR_FUZZY || b.tokens.size < MIN_TOKENS_FOR_FUZZY) {
            return a.tokens.isNotEmpty() && a.tokens == b.tokens
        }
        return jaccard(a.tokens, b.tokens) >= threshold
    }

    private fun jaccard(a: Set<String>, b: Set<String>): Double {
        val intersection = a.count { it in b }
        if (intersection == 0) return 0.0
        val union = a.size + b.size - intersection
        return intersection.toDouble() / union
    }

    /**
     * Lowercase, strip emoji and punctuation, drop stopwords. Reposts routinely
     * differ only by an added emoji, a changed "the", or trailing hashtags, and
     * all of those should still read as the same post.
     */
    private fun tokenize(text: String): Set<String> = text
        .lowercase()
        .map { if (it.isLetterOrDigit() || it.isWhitespace()) it else ' ' }
        .joinToString("")
        .split(' ', '\t', '\n', '\r')
        .filter { it.isNotBlank() && it !in STOPWORDS }
        .toSet()

    private companion object {
        const val MIN_TOKENS_FOR_FUZZY = 3

        val STOPWORDS = setOf(
            "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
            "he", "her", "his", "i", "in", "is", "it", "its", "me", "my", "of",
            "on", "or", "she", "so", "that", "the", "then", "they", "this", "to",
            "was", "were", "when", "with", "you", "your",
        )
    }
}

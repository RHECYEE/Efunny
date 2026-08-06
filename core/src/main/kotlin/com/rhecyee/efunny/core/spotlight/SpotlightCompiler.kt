package com.rhecyee.efunny.core.spotlight

import com.rhecyee.efunny.core.feelers.FeelerResult
import com.rhecyee.efunny.core.model.ScoredPost
import com.rhecyee.efunny.core.model.SourceConfig

/** What one source returned this drop, paired with the config that produced it. */
data class SourceOutcome(val config: SourceConfig, val result: FeelerResult)

/** The finished set of 7. */
data class CompiledDrop(
    val entries: List<ScoredPost>,
    /** Slots that could not be filled by anyone. Non-zero means every source was dry. */
    val shortfall: Int,
    /** Entries taken beyond a source's quota to cover for a source that fell short. */
    val backfilled: Int,
    /** displayName -> reason, surfaced per-source on the Sources screen. */
    val unavailable: Map<String, String>,
)

/**
 * Turns per-source candidates into one drop of [SpotlightSpec.POSTS_PER_DROP].
 */
class SpotlightCompiler(
    private val scorer: TrendScorer,
    private val deduper: Deduper = Deduper(),
) {

    fun compile(
        outcomes: List<SourceOutcome>,
        previouslyShown: Collection<PostFingerprint> = emptyList(),
        target: Int = SpotlightSpec.POSTS_PER_DROP,
    ): CompiledDrop {
        val unavailable = outcomes
            .mapNotNull { o -> (o.result as? FeelerResult.Unavailable)?.let { o.config.displayName to it.reason } }
            .toMap()

        // Cross-drop dedup happens here, before allocation, so a source whose
        // best post already ran at 15:00 offers its runner-up at 20:00 rather
        // than forfeiting the slot.
        val queues = outcomes
            .filter { it.config.enabled }
            .sortedBy { it.config.position }
            .map { outcome ->
                val posts = (outcome.result as? FeelerResult.Success)?.posts.orEmpty()
                val fresh = posts.filterNot { deduper.isDuplicate(it, previouslyShown) }
                outcome.config to ArrayDeque(scorer.score(fresh))
            }

        val selected = mutableListOf<ScoredPost>()
        // The within-drop dedup pass. Cross-drop was already applied to `queues`
        // above, so these two concerns stay visibly separate.
        val selectedFingerprints = mutableListOf<PostFingerprint>()
        var backfilled = 0
        var pass = 0

        // Round-robin passes. Pass 1..quota is each source spending its quota;
        // every pass after that is backfill. Because a pass takes at most one
        // post per source, no source can reach a second slot until every source
        // has had a first -- the quota rule and the backfill rule fall out of
        // the same loop rather than needing to agree with each other.
        while (selected.size < target) {
            pass++
            var tookThisPass = 0

            for ((config, queue) in queues) {
                if (selected.size >= target) break
                val next = pollFirstNonDuplicate(queue, selectedFingerprints) ?: continue
                selected += next
                selectedFingerprints += deduper.fingerprint(next.post)
                tookThisPass++
                if (pass > config.quotaPerDrop) backfilled++
            }

            if (tookThisPass == 0) break // every source is dry; stop rather than spin
        }

        return CompiledDrop(
            entries = selected.sortedByDescending { it.score },
            shortfall = (target - selected.size).coerceAtLeast(0),
            backfilled = backfilled,
            unavailable = unavailable,
        )
    }

    /** Pops the best candidate that is not a repeat of something already chosen. */
    private fun pollFirstNonDuplicate(
        queue: ArrayDeque<ScoredPost>,
        taken: List<PostFingerprint>,
    ): ScoredPost? {
        while (queue.isNotEmpty()) {
            val candidate = queue.removeFirst()
            if (!deduper.isDuplicate(candidate.post, taken)) return candidate
        }
        return null
    }
}

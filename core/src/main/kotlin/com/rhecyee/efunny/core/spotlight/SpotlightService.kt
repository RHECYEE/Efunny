package com.rhecyee.efunny.core.spotlight

import com.rhecyee.efunny.core.feelers.Feeler
import com.rhecyee.efunny.core.feelers.FeelerResult
import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.time.Clock

/**
 * Runs one drop end to end: put out the feelers, then compile what comes back.
 *
 * This is the whole pipeline the Android worker calls; everything it depends on
 * is plain JVM code, so a full drop can be exercised in a unit test.
 */
class SpotlightService(
    private val feelers: Map<SourceType, Feeler>,
    private val compiler: SpotlightCompiler,
    private val clock: Clock,
) {

    suspend fun runDrop(
        configs: List<SourceConfig>,
        previouslyShown: Collection<PostFingerprint> = emptyList(),
        target: Int = SpotlightSpec.POSTS_PER_DROP,
    ): CompiledDrop {
        val window = TimeWindow.lastHours(clock.instant(), SpotlightSpec.LOOKBACK_HOURS)

        // Sources are independent, so a slow feed delays only itself. One
        // source throwing must not take the drop down -- a thrown exception
        // becomes that source's Unavailable and the slot gets redistributed.
        val outcomes = coroutineScope {
            configs.filter { it.enabled }.map { config ->
                async {
                    val feeler = feelers[config.type]
                        ?: return@async SourceOutcome(
                            config,
                            FeelerResult.Unavailable("No feeler registered for ${config.type}"),
                        )
                    val result = try {
                        feeler.fetch(config, window)
                    } catch (e: Exception) {
                        FeelerResult.Unavailable("Failed: ${e.message ?: e::class.simpleName}")
                    }
                    SourceOutcome(config, result)
                }
            }.map { it.await() }
        }

        return compiler.compile(outcomes, previouslyShown, target)
    }
}

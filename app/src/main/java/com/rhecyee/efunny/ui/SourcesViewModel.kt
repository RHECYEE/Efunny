package com.rhecyee.efunny.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.rhecyee.efunny.EFunnyGraph
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.data.EFunnyDatabase
import com.rhecyee.efunny.data.SourceConfigEntity
import com.rhecyee.efunny.schedule.DropScheduler
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SourcesViewModel(app: Application) : AndroidViewModel(app) {

    private val dao = EFunnyDatabase.get(app).dao()
    private val settings = EFunnyGraph.settings(app)

    val sources: StateFlow<List<SourceConfigEntity>> = dao.observeSources()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun youtubeKey(): String = settings.youtubeApiKey().orEmpty()
    fun redditClientId(): String = settings.redditClientId().orEmpty()
    fun dropZone(): String = settings.dropZone().id
    fun searchCallsUsedToday(): Int = settings.searchCallsUsedToday()

    fun setYouTubeKey(value: String) = settings.setYouTubeApiKey(value)

    fun setRedditClientId(value: String) = settings.setRedditClientId(value)

    fun setDropZone(zoneId: String) {
        settings.setDropZone(zoneId)
        // Every future fire time just moved, so the pending chain is stale.
        DropScheduler.reschedule(getApplication())
    }

    fun setEnabled(source: SourceConfigEntity, enabled: Boolean) = viewModelScope.launch {
        dao.updateSource(source.copy(enabled = enabled))
    }

    fun setQuota(source: SourceConfigEntity, quota: Int) = viewModelScope.launch {
        dao.updateSource(source.copy(quotaPerDrop = quota.coerceIn(0, 7)))
    }

    fun addRssSource(name: String, url: String, useDescription: Boolean) = viewModelScope.launch {
        val id = dao.maxSourceId() + 1
        dao.upsertSources(
            listOf(
                SourceConfigEntity(
                    id = id,
                    type = SourceType.RSS.name,
                    displayName = name.ifBlank { url },
                    params = buildMap {
                        put("url", url.trim())
                        if (useDescription) put("text", "description")
                    },
                    quotaPerDrop = 1,
                    enabled = true,
                    position = id.toInt(),
                ),
            ),
        )
    }

    fun addSubreddit(subreddit: String) = viewModelScope.launch {
        val clean = subreddit.trim().removePrefix("r/")
        val id = dao.maxSourceId() + 1
        dao.upsertSources(
            listOf(
                SourceConfigEntity(
                    id = id,
                    type = SourceType.REDDIT.name,
                    displayName = "r/$clean",
                    params = mapOf("subreddit" to clean),
                    quotaPerDrop = 1,
                    enabled = true,
                    position = id.toInt(),
                ),
            ),
        )
    }

    fun delete(source: SourceConfigEntity) = viewModelScope.launch { dao.deleteSource(source.id) }

    fun runDropNow() = DropScheduler.runNow(getApplication())
}

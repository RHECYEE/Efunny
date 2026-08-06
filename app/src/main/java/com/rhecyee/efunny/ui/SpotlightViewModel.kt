package com.rhecyee.efunny.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.rhecyee.efunny.EFunnyGraph
import com.rhecyee.efunny.data.SpotlightEntity
import com.rhecyee.efunny.data.SpotlightPost
import com.rhecyee.efunny.schedule.DropScheduler
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class SpotlightUiState(
    val drops: List<SpotlightEntity> = emptyList(),
    val selected: SpotlightEntity? = null,
    val posts: List<SpotlightPost> = emptyList(),
    val refreshing: Boolean = false,
)

@OptIn(ExperimentalCoroutinesApi::class)
class SpotlightViewModel(app: Application) : AndroidViewModel(app) {

    private val repository = EFunnyGraph.repository(app)

    private val selectedId = MutableStateFlow<Long?>(null)
    private val refreshing = MutableStateFlow(false)

    private val drops = repository.observeRecentSpotlights()

    val state: StateFlow<SpotlightUiState> =
        combine(drops, selectedId, refreshing) { list, chosen, isRefreshing ->
            // Default to the newest drop, but hold the user's pick once made.
            val selected = list.firstOrNull { it.id == chosen } ?: list.firstOrNull()
            Triple(list, selected, isRefreshing)
        }.flatMapLatest { (list, selected, isRefreshing) ->
            if (selected == null) {
                flowOf(SpotlightUiState(drops = list, refreshing = isRefreshing))
            } else {
                repository.observeEntries(selected.id).let { entries ->
                    combine(flowOf(list), entries) { allDrops, posts ->
                        SpotlightUiState(allDrops, selected, posts, isRefreshing)
                    }
                }
            }
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SpotlightUiState())

    init {
        viewModelScope.launch { repository.ensureSeeded() }
        DropScheduler.ensureScheduled(app)
    }

    fun select(id: Long) {
        selectedId.value = id
    }

    /**
     * Recompiles the current slot on demand. The work still runs through
     * WorkManager rather than in the ViewModel, so a refresh survives the user
     * navigating away mid-fetch.
     */
    fun refresh() {
        refreshing.value = true
        DropScheduler.runNow(getApplication())
        viewModelScope.launch {
            kotlinx.coroutines.delay(1_500)
            refreshing.value = false
        }
    }
}

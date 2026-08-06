package com.rhecyee.efunny.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkManager
import com.rhecyee.efunny.EFunnyGraph
import com.rhecyee.efunny.core.schedule.DropSchedule
import com.rhecyee.efunny.data.SpotlightEntity
import com.rhecyee.efunny.data.SpotlightPost
import com.rhecyee.efunny.schedule.DropScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
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

    /**
     * Driven by WorkManager rather than a timer. The drop runs as background
     * work so it survives the user navigating away, which means the only honest
     * source of "still refreshing" is the work's own state.
     */
    private val refreshing: Flow<Boolean> =
        WorkManager.getInstance(app)
            .getWorkInfosForUniqueWorkFlow(DropScheduler.MANUAL_WORK)
            .map { infos -> infos.any { !it.state.isFinished } }

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

    /**
     * Backs the countdown on the end-of-spotlight card. Held as state rather
     * than rebuilt per tick because constructing it reads the encrypted prefs
     * for the drop time zone, and the card ticks once a second.
     */
    private val _schedule = MutableStateFlow<DropSchedule?>(null)
    val schedule: StateFlow<DropSchedule?> = _schedule

    init {
        // Arming the chain reads the encrypted prefs, which touches the
        // keystore -- off the main thread so first frame is not held up by it.
        viewModelScope.launch(Dispatchers.IO) {
            repository.ensureSeeded()
            DropScheduler.ensureScheduled(app)
            _schedule.value = EFunnyGraph.schedule(app)
        }
    }

    fun select(id: Long) {
        selectedId.value = id
    }

    /** Recompiles the current slot on demand. */
    fun refresh() {
        viewModelScope.launch(Dispatchers.IO) { DropScheduler.runNow(getApplication()) }
    }
}

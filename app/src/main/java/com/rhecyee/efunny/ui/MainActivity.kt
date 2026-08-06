package com.rhecyee.efunny.ui

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.rhecyee.efunny.schedule.DropScheduler
import com.rhecyee.efunny.ui.theme.EFunnyTheme

class MainActivity : ComponentActivity() {

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* denied is fine */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Make sure the chain is armed even if the app has never run a drop.
        DropScheduler.ensureScheduled(this)

        setContent {
            EFunnyTheme {
                LaunchedEffect(Unit) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }

                val nav = rememberNavController()
                NavHost(navController = nav, startDestination = "spotlight") {
                    composable("spotlight") {
                        SpotlightScreen(onOpenSources = { nav.navigate("sources") })
                    }
                    composable("sources") {
                        SourcesScreen(onBack = { nav.popBackStack() })
                    }
                }
            }
        }
    }
}

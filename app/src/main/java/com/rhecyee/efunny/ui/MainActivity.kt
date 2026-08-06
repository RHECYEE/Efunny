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
import com.rhecyee.efunny.ui.theme.EFunnyTheme

class MainActivity : ComponentActivity() {

    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* denied is fine */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // The drop chain is armed by SpotlightViewModel's init, off the main
        // thread -- arming it here would put an encrypted-prefs read (and so a
        // keystore round trip) in front of the first frame.
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

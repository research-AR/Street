import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MindARThree } from 'mindar-image-three';


document.addEventListener('DOMContentLoaded', () => {
    const start = async () => {

        // ============ MINDAR SETUP ============
        
        const arContainer = document.createElement('div');
        arContainer.id = 'ar-container';
        document.body.appendChild(arContainer);

        const mindarThree = new MindARThree({
            container: arContainer,
            imageTargetSrc: "./applications-20230306/applications/assets/targets/targettoplu.mind",
            maxTrack: 3, // Allow tracking of 3 targets
            filterMinCF: 0.0001, // Lower value for better tracking
            filterBeta: 10,      // Higher value for more smoothing (was 1000, which is too high)
            warmupTolerance: 10, // More tolerance for warmup
            missTolerance: 10    // More tolerance for brief tracking losses
        });
        const {renderer, scene, camera} = mindarThree;

        // Position the AR canvas to fill the screen
        renderer.domElement.style.position = 'absolute';
        renderer.domElement.style.inset = '0';
        renderer.domElement.style.zIndex = '0';
        
        // Optimize renderer for better performance
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap pixel ratio for performance

        // Add lighting to the scene
        const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
        scene.add(light);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 1, 1);
        scene.add(directionalLight);

        // Create anchor points for AR tracking
        const anchor = mindarThree.addAnchor(0); // First target (main scenes)
        // Second anchor will be created later when needed (performance optimization)

        // --- SMOOTHING GROUP (to reduce jitter) ---
        // The smoothed group is at scene level, not as child of anchor
        // This allows us to interpolate its world transform independently
        const smoothed = new THREE.Group();
        scene.add(smoothed); // Add to scene, not to anchor

        // --- HUD (screen-fixed arrows) ---
        injectHUDStyles();
        const { hud, prevB, nextB, replayB, label } = createHUD(); // appended to <body>, hidden by default
        hud.hidden = true;

        // --- models list + helpers ---
        const TOTAL = 3; // Total number of AR scenes on first target
        const models = new Array(TOTAL); // Array to store loaded 3D models
        const slotControllers = new Array(TOTAL);  // optional onEnter/onLeave per slot
        let index = 0; // Current active scene index
        let lastActive = -1; // Previously active scene index
        let targetFound = false; // Track if target is currently found
        
        // --- Second target system (middle target with 3 scenes, last one is guide) ---
        let secondTargetActive = false; // Track if second target is active
        let secondAnchor = null; // Second target anchor (created when first target completes)
        let secondAnchorInitialized = false; // Track if second anchor has been set up
        
        // Second target scenes
        const SECOND_TOTAL = 3; // Total number of scenes on second target (including guide scene)
        const secondModels = new Array(SECOND_TOTAL); // Array to store second target models
        const secondSlotControllers = new Array(SECOND_TOTAL); // Controllers for second target slots
        let secondIndex = 0; // Current active scene on second target
        let secondLastActive = -1; // Previously active scene on second target
        let secondTargetFound = false; // Track if second target is currently visible
        
        // --- Third target system (building target) ---
        let viewedScenes = new Set(); // Track which scenes have been viewed (from first target)
        let allScenesCompleted = false; // Track if all first target scenes are finished
        let secondViewedScenes = new Set(); // Track which second target scenes have been viewed
        let allSecondScenesCompleted = false; // Track if all second target scenes (1&2) are finished
        let thirdTargetActive = false; // Track if third target is active
        let thirdAnchor = null; // Third target anchor (created lazily for performance)
        let thirdAnchorInitialized = false; // Track if third anchor has been set up
        
        // Third target scenes (building scenes)
        const THIRD_TOTAL = 3; // Total number of scenes on third target
        const thirdModels = new Array(THIRD_TOTAL); // Array to store third target models
        const thirdSlotControllers = new Array(THIRD_TOTAL); // Controllers for third target slots
        let thirdIndex = 0; // Current active scene on third target
        let thirdLastActive = -1; // Previously active scene on third target
        let thirdTargetFound = false; // Track if third target is currently visible

        const loader = new GLTFLoader();

        const countLoaded = () => models.filter(Boolean).length;
        const secondCountLoaded = () => secondModels.filter(Boolean).length;
        const thirdCountLoaded = () => thirdModels.filter(Boolean).length;
        
        function updateLabel() {
        // show current slot number if that slot is loaded; otherwise 0
                label.textContent = `${models[index] ? index + 1 : 0}/${TOTAL}`;
        }
        
        // Track scene viewing and check for completion
        function markSceneViewed(sceneIndex) {
            // Track all 3 scenes of first target
            if (sceneIndex < 3) {
                viewedScenes.add(sceneIndex);
                console.log(`[Target 1] Scene ${sceneIndex + 1} viewed. Total viewed: ${viewedScenes.size}/3`);
                
                // Check if all 3 scenes are completed
                if (viewedScenes.size >= 3 && !allScenesCompleted) {
                    allScenesCompleted = true;
                    console.log('🎉 All first target scenes completed! Second target will be available.');
                    updateLabel();
                    updateNavigationButtons(); // Enable navigation to second target
                }
            }
        }
        
        // Track second target scene viewing and check for completion
        function markSecondSceneViewed(sceneIndex) {
            // Only track first 2 scenes of second target (not the guide scene 3)
            if (sceneIndex < 2) {
                secondViewedScenes.add(sceneIndex);
                console.log(`[Target 2] Scene ${sceneIndex + 1} viewed. Total viewed: ${secondViewedScenes.size}/2`);
                
                // Check if scenes 1 & 2 are completed
                if (secondViewedScenes.size >= 2 && !allSecondScenesCompleted) {
                    allSecondScenesCompleted = true;
                    console.log('🎉 All second target scenes completed! Guide scene (scene 3) unlocked.');
                    secondUpdateNavigationButtons(); // Enable navigation to scene 3 (guide)
                }
            }
        }
        

        // ---------- OCCLUSION HELPERS ----------
        // Prepare content models for proper depth rendering
        function prepContent(root){
            root.traverse(o => {
                if (o.isMesh) {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach(m => {
                        if (!m) return;
                        m.depthTest = true;
                        m.depthWrite = true;
                        m.colorWrite = true;
                        // Pull content slightly forward to appear in front of occluders
                        m.polygonOffset = true;
                        m.polygonOffsetFactor = -2;  // Negative = pull forward
                        m.polygonOffsetUnits = -2;   // Pull forward
                    });
                    o.renderOrder = 1; // draw AFTER occluders
                }
            });
        }

        // Prepare occluder models (invisible depth writers)
        function prepOccluder(root){
            root.traverse(o => {
                if (o.isMesh) {
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach(m => {
                        if (!m) return;
                        // invisible but writes to depth buffer
                        m.colorWrite = false;
                        m.depthWrite = true;
                        m.depthTest  = true;
                        // Push occluder depth back to allow recessed windows (1mm deep) to appear
                        m.polygonOffset = true;
                        m.polygonOffsetFactor = 2;  // Positive = push back (was -2)
                        m.polygonOffsetUnits  = 2;  // Push back by ~2mm
                    });
                    o.renderOrder = 0; // draw BEFORE content
                }
            });
        }



        // Show/hide models based on current scene and handle scene transitions
        function applyVisibility() {
            models.forEach((m, i) => { if (m) m.visible = (i === index); });
            // fire leave/enter once per slot change
            if (lastActive !== index) {
                if (lastActive >= 0 && slotControllers[lastActive]?.onLeave) {
                    slotControllers[lastActive].onLeave();
                }
                if (slotControllers[index]?.onEnter) {
                    slotControllers[index].onEnter();
                }
                // Mark this scene as viewed
                if (models[index]) {
                    markSceneViewed(index);
                }
                
                lastActive = index;
            }
            
            updateLabel();
            updateNavigationButtons();
        }

        function nextLoaded(from, dir) {
        // walk circularly through fixed slots, skipping unloaded ones
            let i = from;
            for (let step = 0; step < TOTAL; step++) {
                i = (i + dir + TOTAL) % TOTAL;
                if (models[i]) return i;
            }
            return from; 
        }


        function showDelta(delta) {
            if (countLoaded() === 0) return;
            index = nextLoaded(index, delta >= 0 ? +1 : -1);
            applyVisibility();
        }

        // Replay current scene function
        function replayCurrentScene() {
            console.log(`Replaying scene ${index}...`);
            const controller = slotControllers[index];
            if (controller && controller.isComposite) {
                // Reset and restart the composite sequence
                controller.onLeave(); // Clean up current state
                controller.onEnter(); // Restart sequence
                console.log(`Scene ${index} replay initiated`);
            } else {
                console.log(`Scene ${index} is not a composite scene, no replay needed`);
            }
        }

        // Set up navigation button handlers for all targets
        const goPrev = () => {
            if (thirdTargetActive) {
                thirdShowDelta(-1);
            } else if (secondTargetActive) {
                secondShowDelta(-1);
            } else {
                showDelta(-1);
            }
        };
        const goNext = () => {
            if (thirdTargetActive) {
                thirdShowDelta(+1);
            } else if (secondTargetActive) {
                secondShowDelta(+1);
            } else {
                // Check if on first target and all scenes completed
                if (index === TOTAL - 1 && allScenesCompleted && !secondAnchorInitialized) {
                    // User clicked next after completing all first target scenes
                    // Initialize second target and show message
                    console.log('🚀 Initializing second target...');
                    initializeSecondAnchor();
                    showScanSecondTargetMessage();
            } else {
                showDelta(+1);
                }
            }
        };
        const goReplay = () => {
            if (thirdTargetActive) {
                replayThirdTargetScene();
            } else if (secondTargetActive) {
                replaySecondTargetScene();
            } else {
                replayCurrentScene();
            }
        };
        prevB.addEventListener('click', goPrev);
        nextB.addEventListener('click', goNext);
        replayB.addEventListener('click', goReplay);
        
        // ============ SECOND TARGET NAVIGATION ============
        // Navigation functions for second target (similar to first target)
        function secondApplyVisibility() {
            // Hide all first target models when on second target
            models.forEach(m => { if (m) m.visible = false; });
            
            // Show only current second target scene
            secondModels.forEach((m, i) => { if (m) m.visible = (i === secondIndex); });
            
            // fire leave/enter once per slot change
            if (secondLastActive !== secondIndex) {
                if (secondLastActive >= 0 && secondSlotControllers[secondLastActive]?.onLeave) {
                    secondSlotControllers[secondLastActive].onLeave();
                }
                if (secondSlotControllers[secondIndex]?.onEnter) {
                    secondSlotControllers[secondIndex].onEnter();
                }
                
                // Mark this scene as viewed
                if (secondModels[secondIndex]) {
                    markSecondSceneViewed(secondIndex);
                }
                
                // Initialize third anchor when reaching scene 3 (guide scene) of second target
                if (secondIndex === 2 && !thirdAnchorInitialized) {
                    console.log('📍 Initializing third target tracking (second target scene 3 reached)...');
                    initializeThirdAnchor();
                }
                
                secondLastActive = secondIndex;
            }
            
            secondUpdateLabel();
            secondUpdateNavigationButtons();
        }
        
        function secondNextLoaded(from, dir) {
            let i = from;
            for (let step = 0; step < SECOND_TOTAL; step++) {
                i = (i + dir + SECOND_TOTAL) % SECOND_TOTAL;
                // Skip scene 3 (guide) if first 2 scenes not completed
                if (i === 2 && !allSecondScenesCompleted) {
                    continue;
                }
                if (secondModels[i]) return i;
            }
            return from;
        }
        
        function secondShowDelta(delta) {
            if (secondCountLoaded() === 0) return;
            console.log(`[Target 2] Navigating from scene ${secondIndex} with delta ${delta}`);
            secondIndex = secondNextLoaded(secondIndex, delta >= 0 ? +1 : -1);
            console.log(`[Target 2] Now on scene ${secondIndex}`);
            secondApplyVisibility();
        }
        
        // Replay current second target scene function
        function replaySecondTargetScene() {
            console.log(`Replaying second target scene ${secondIndex}...`);
            const controller = secondSlotControllers[secondIndex];
            if (controller && controller.isComposite) {
                // Reset and restart the composite sequence
                controller.onLeave(); // Clean up current state
                controller.onEnter(); // Restart sequence
                console.log(`Second target scene ${secondIndex} replay initiated`);
            } else {
                console.log(`Second target scene ${secondIndex} is not a composite scene, no replay needed`);
            }
        }
        
        function secondUpdateLabel() {
            if (secondIndex === 2 && allSecondScenesCompleted) {
                label.textContent = `Guide: Find the Building`;
            } else {
                label.textContent = `Target 2 - Scene ${secondIndex + 1}/${SECOND_TOTAL}`;
            }
        }
        
        function thirdUpdateLabel() {
            label.textContent = `Building ${thirdIndex + 1}/${THIRD_TOTAL}`;
        }
        
        function secondUpdateNavigationButtons() {
            const currentSlot = secondSlotControllers[secondIndex];
            const loadedCount = secondCountLoaded();
            
            // Check if we can go to previous scene
            const canGoPrev = secondIndex > 0;
            prevB.disabled = !canGoPrev;
            prevB.style.opacity = canGoPrev ? '1' : '0.5';
            
            // Check if we can go to next scene
            let canGoNext = false;
            if (currentSlot && currentSlot.isComposite) {
                const allPartsVisible = currentSlot.areAllPartsVisible ? currentSlot.areAllPartsVisible() : true;
                canGoNext = allPartsVisible && secondIndex < loadedCount - 1;
                
                // Block navigation from scene 2 to scene 3 (guide) until scenes 1&2 completed
                if (secondIndex === 1 && !allSecondScenesCompleted) {
                    canGoNext = false;
                }
            } else {
                canGoNext = secondIndex < loadedCount - 1;
                
                // Block navigation from scene 2 to scene 3 (guide) until scenes 1&2 completed
                if (secondIndex === 1 && !allSecondScenesCompleted) {
                    canGoNext = false;
                }
            }
            
            nextB.disabled = !canGoNext;
            nextB.style.opacity = canGoNext ? '1' : '0.5';
        }
        
        // ============ THIRD TARGET NAVIGATION ============
        // Navigation functions for third target (building target)
        function thirdApplyVisibility() {
            // Hide all other targets' models when on third target
            models.forEach(m => { if (m) m.visible = false; });
            secondModels.forEach(m => { if (m) m.visible = false; });
            
            // Show only current third target scene
            thirdModels.forEach((m, i) => { if (m) m.visible = (i === thirdIndex); });
            
            // fire leave/enter once per slot change
            if (thirdLastActive !== thirdIndex) {
                if (thirdLastActive >= 0 && thirdSlotControllers[thirdLastActive]?.onLeave) {
                    thirdSlotControllers[thirdLastActive].onLeave();
                }
                if (thirdSlotControllers[thirdIndex]?.onEnter) {
                    thirdSlotControllers[thirdIndex].onEnter();
                }
                thirdLastActive = thirdIndex;
            }
            
            thirdUpdateLabel();
            thirdUpdateNavigationButtons();
        }
        
        function thirdNextLoaded(from, dir) {
            let i = from;
            for (let step = 0; step < THIRD_TOTAL; step++) {
                i = (i + dir + THIRD_TOTAL) % THIRD_TOTAL;
                if (thirdModels[i]) return i;
            }
            return from;
        }
        
        function thirdShowDelta(delta) {
            if (thirdCountLoaded() === 0) return;
            thirdIndex = thirdNextLoaded(thirdIndex, delta >= 0 ? +1 : -1);
            thirdApplyVisibility();
        }
        
        // Replay current third target scene function
        function replayThirdTargetScene() {
            console.log(`Replaying third target scene ${thirdIndex}...`);
            const controller = thirdSlotControllers[thirdIndex];
            if (controller && controller.isComposite) {
                // Reset and restart the composite sequence
                controller.onLeave(); // Clean up current state
                controller.onEnter(); // Restart sequence
                console.log(`Third target scene ${thirdIndex} replay initiated`);
            } else {
                console.log(`Third target scene ${thirdIndex} is not a composite scene, no replay needed`);
            }
        }
        
        function thirdUpdateNavigationButtons() {
            const currentSlot = thirdSlotControllers[thirdIndex];
            const loadedCount = thirdCountLoaded();
            
            // Check if we can go to previous scene
            const canGoPrev = thirdIndex > 0;
            prevB.disabled = !canGoPrev;
            prevB.style.opacity = canGoPrev ? '1' : '0.5';
            
            // Check if we can go to next scene
            let canGoNext = false;
            if (currentSlot && currentSlot.isComposite) {
                const allPartsVisible = currentSlot.areAllPartsVisible ? currentSlot.areAllPartsVisible() : true;
                canGoNext = allPartsVisible && thirdIndex < loadedCount - 1;
            } else {
                canGoNext = thirdIndex < loadedCount - 1;
            }
            
            nextB.disabled = !canGoNext;
            nextB.style.opacity = canGoNext ? '1' : '0.5';
        }

        // Function to update navigation button states
        function updateNavigationButtons() {
            const currentSlot = slotControllers[index];
            const loadedCount = countLoaded();
            
            // Check if we can go to previous scene
            const canGoPrev = index > 0;
            prevB.disabled = !canGoPrev;
            prevB.style.opacity = canGoPrev ? '1' : '0.5';
            
            // Check if we can go to next scene
            let canGoNext = false;
            if (currentSlot && currentSlot.isComposite) {
                // For composite slots, check if all parts are visible
                const allPartsVisible = currentSlot.areAllPartsVisible ? currentSlot.areAllPartsVisible() : true;
                canGoNext = allPartsVisible && index < loadedCount - 1;
                
                // Special case: if on last scene (index 2) and all scenes completed, enable next to go to second target
                if (index === TOTAL - 1 && allScenesCompleted && allPartsVisible) {
                    canGoNext = true; // Enable to initialize second target
                }
            } else {
                // For regular slots, just check if there's a next scene
                canGoNext = index < loadedCount - 1;
                
                // Special case: if on last scene and all completed, enable next to go to second target
                if (index === TOTAL - 1 && allScenesCompleted) {
                    canGoNext = true; // Enable to initialize second target
                }
            }
            
            nextB.disabled = !canGoNext;
            nextB.style.opacity = canGoNext ? '1' : '0.5';
        }

        // Show HUD only while target is tracked
        anchor.onTargetFound = () => { 
            // CRITICAL: Only activate Target 1 if no other target is active
            if (secondTargetActive || thirdTargetActive) {
                console.log('⚠️ Target 1 found but another target is active - ignoring to prevent interference');
                console.log('[Debug] Active states - Target2:', secondTargetActive, 'Target3:', thirdTargetActive);
                return; // Don't activate first target if another is active
            }
            
            console.log('🎯 Target 1 found! Activating...');
            hud.hidden = false; 
            
            // Hide all other targets' models
            secondModels.forEach(m => { if (m) m.visible = false; });
            thirdModels.forEach(m => { if (m) m.visible = false; });
            
            // Initialize smoothed group position on first detection to prevent initial snap
            if (!targetFound) {
                anchor.group.getWorldPosition(smoothed.position);
                anchor.group.getWorldQuaternion(smoothed.quaternion);
                anchor.group.getWorldScale(smoothed.scale);
            }
            
            targetFound = true;
            
            console.log(`Target 1 found! Current slot: ${index}, slotControllers[${index}]:`, slotControllers[index]);
            
            // Deactivate other targets
            secondTargetActive = false;
            thirdTargetActive = false;
            
            // Show first target occluders
            showFirstTargetOccluders();
            
            // Re-apply visibility to show current scene
            applyVisibility();
            
            // Trigger composite sequence if we're on a composite slot and it hasn't started yet
            if (slotControllers[index] && slotControllers[index].isComposite && !slotControllers[index].started) {
                console.log(`Target found, starting composite sequence for slot ${index}...`);
                slotControllers[index].startSequenceIfReady();
            } else {
                console.log(`Target found but not starting composite sequence - slotControllers[${index}]:`, slotControllers[index] ? `isComposite: ${slotControllers[index].isComposite}, started: ${slotControllers[index].started}` : 'null');
            }
        };
        anchor.onTargetLost = () => { 
            console.log('Target 1 lost.');
            targetFound = false;
            // Only hide HUD if no other target is active
            if (!secondTargetActive && !thirdTargetActive) {
                hud.hidden = true;
            }
            // Note: We don't hide the models here, as user might switch to another target
        };
        
        // ============ SECOND TARGET HANDLERS (Middle Target) ============
        // Initialize second anchor and its event handlers (created immediately)
        function initializeSecondAnchor() {
            if (secondAnchorInitialized) return; // Already initialized
            
            console.log('Creating second anchor (middle target) for tracking...');
            secondAnchor = mindarThree.addAnchor(1); // Create second target anchor (index 1)
            secondAnchorInitialized = true;
            
            // Create second smoothed group for second target (at scene level)
            secondSmoothed = new THREE.Group();
            scene.add(secondSmoothed); // Add to scene for independent interpolation
            
            // Set up event handlers for second target
            setupSecondTargetHandlers();
            
            // Load second target scenes
            loadSecondTargetScenes();
        }
        
        // Set up event handlers for second target
        function setupSecondTargetHandlers() {
            secondAnchor.onTargetFound = () => {
                // Only activate if first target scenes are completed
                if (!allScenesCompleted) {
                    console.log('Second target found but first target scenes not completed yet.');
                    showNotReadyMessage();
                    return;
                }
                
                // CRITICAL: Only activate Target 2 if no other target is active
                if (thirdTargetActive) {
                    console.log('⚠️ Target 2 found but Target 3 is active - ignoring to prevent interference');
                    return;
                }
                
                console.log('🎯 Second target (middle) found! Showing scenes...');
                console.log('[Debug] Activating Target 2, current scene:', secondIndex);
                
                // Hide all other targets' models
                models.forEach(m => { if (m) m.visible = false; });
                thirdModels.forEach(m => { if (m) m.visible = false; });
                
                // Hide first target occluders (they only apply to first target)
                hideFirstTargetOccluders();
                
                // Deactivate other targets
                thirdTargetActive = false;
                
                // Initialize second smoothed group position on first detection to prevent initial snap
                if (!secondTargetFound && secondSmoothed) {
                    secondAnchor.group.getWorldPosition(secondSmoothed.position);
                    secondAnchor.group.getWorldQuaternion(secondSmoothed.quaternion);
                    secondAnchor.group.getWorldScale(secondSmoothed.scale);
                }
                    
                    secondTargetActive = true;
                    secondTargetFound = true;
                    // Show HUD for navigation
                    hud.hidden = false;
                    secondUpdateLabel();
                    secondUpdateNavigationButtons();
                    
                    // Trigger composite sequence if on composite slot
                    if (secondSlotControllers[secondIndex] && secondSlotControllers[secondIndex].isComposite && !secondSlotControllers[secondIndex].started) {
                        secondSlotControllers[secondIndex].startSequenceIfReady();
                    }
                    
                    showSecondTargetContent();
            };
            
            secondAnchor.onTargetLost = () => {
                if (secondTargetActive) {
                    console.log('⚠️ Second target tracking lost! Deactivating second target.');
                    console.log('[Debug] Current states - Target1:', targetFound, 'Target2:', secondTargetFound, 'Target3:', thirdTargetFound);
                    secondTargetActive = false;
                    secondTargetFound = false;
                    // Only hide HUD if no other target is active
                    if (!targetFound && !thirdTargetActive) {
                        hud.hidden = true;
                        console.log('[Debug] HUD hidden - no active targets');
                    }
                    hideSecondTargetContent();
                }
            };
        }
        
        // Load all second target scenes (3 scenes, last one is guide)
        function loadSecondTargetScenes() {
            console.log('Loading second target (middle) scenes...');
            
            // Second Target Scene 1 - Composite scene
            secondLoadComposite(0, [
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/gunes.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/yazi1.gltf",
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/yazi2.gltf",  
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/yazi3.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/yazi4.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/binalar.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/isiklar.gltf", 
            ], 
            [0, 0, 250, 500, 750, 1000, 1000,],     // Timing
            [0, 0, 0, 0, 0, 0, 0]);       // hideAfter: stays forever
            
            // Second Target Scene 2 - Composite scene
            // TEMPORARY: Add at least one model to prevent empty scene issues
            secondLoadComposite(1, [
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/cizgi1.gltf",
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/cizgikapanacak.gltf",
                
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/gunesgltf.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/Soru1.gltf",
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/Soru2.gltf",  
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/Soru3.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/Soru4.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/binalar.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne1/isiklar.gltf", 

                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/cizgi2.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/ok.gltf",               
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/cizgi3.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/cizgi4.gltf", 
                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/cizgi5.gltf", 


                "./applications-20230306/applications/assets/DataModel11_3/Franz/Sahne2/isiklar.gltf", 
            ], 
            [0, 0, 
            0, 0, 250, 500, 750, 0, 0,
            1000, 1000, 1250, 2500, 1000,
            0,],   
              // Timing: appears immediately
            [0, 1000,
            0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0,
            0,]);    // hideAfter: stays forever
            
            // Second Target Scene 3 - Guide scene (line drawing)
            loadSecondTargetGuideScene();
        }
        
        // Load guide scene for second target (scene 3)
        function loadSecondTargetGuideScene() {
            const group = new THREE.Group();
            group.name = 'second-target-guide-scene';
            
            // Create a plane for the line drawing image
            const textureLoader = new THREE.TextureLoader();
            textureLoader.load(
                './applications-20230306/applications/assets/DataModel11_3/Sahne4/binacizgi.png',
                (texture) => {
                    // Create plane geometry with appropriate aspect ratio
                    const aspectRatio = texture.image.width / texture.image.height;
                    const planeWidth = 0.3;
                    const planeHeight = planeWidth / aspectRatio;
                    
                    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
                    const material = new THREE.MeshBasicMaterial({
                        map: texture,
                        transparent: true,
                        side: THREE.DoubleSide
                    });
                    
                    const linePlane = new THREE.Mesh(geometry, material);
                    linePlane.position.set(0, 0.05, 0); // Slightly above the target
                    group.add(linePlane);
                    
                    // Add instruction text
                    createTextSprite('Turn to your right\nuntil you match the line', group);
                    
                    secondRegister(group, 2); // Register as second target scene 3 (index 2)
                },
                undefined,
                (err) => console.error('Error loading second target guide image:', err)
            );
        }
        
        // Show content for second target
        function showSecondTargetContent() {
            console.log('Displaying second target composite scenes...');
            console.log('[Target 2] Current scene index:', secondIndex);
            console.log('[Target 2] Scene model exists:', !!secondModels[secondIndex]);
            // Ensure first target models are hidden
            models.forEach(m => { if (m) m.visible = false; });
            // Show the current scene on second target
            secondApplyVisibility();
        }
        
        // Hide second target content
        function hideSecondTargetContent() {
            console.log('Hiding second target content...');
            // Hide all second target models
            secondModels.forEach(m => { if (m) m.visible = false; });
        }
        
        // ============ THIRD TARGET HANDLERS (Building Target) ============
        // Initialize third anchor and its event handlers (called when scene 4 is reached)
        function initializeThirdAnchor() {
            if (thirdAnchorInitialized) return; // Already initialized
            
            console.log('Creating third anchor for building tracking...');
            thirdAnchor = mindarThree.addAnchor(2); // Create third target anchor (index 2)
            thirdAnchorInitialized = true;
            
            // Create third smoothed group for third target (at scene level)
            thirdSmoothed = new THREE.Group();
            scene.add(thirdSmoothed); // Add to scene for independent interpolation
            
            // Set up event handlers for third target
            setupThirdTargetHandlers();
            
            // Load third target scenes
            loadThirdTargetScenes();
        }
        
        // Set up event handlers for third target
        function setupThirdTargetHandlers() {
            thirdAnchor.onTargetFound = () => {
                // Only activate if BOTH first and second target scenes are completed
                if (!allScenesCompleted || !allSecondScenesCompleted) {
                    console.log('Third target found but previous targets not completed yet.');
                    showNotReadyForThirdTargetMessage();
                    return;
                }
                
                // CRITICAL: Only activate Target 3 if no other target is active
                if (secondTargetActive) {
                    console.log('⚠️ Target 3 found but Target 2 is active - ignoring to prevent interference');
                    return;
                }
                
                console.log('🎯 Third target (building) found! Showing building scenes...');
                console.log('[Debug] Activating Target 3, current scene:', thirdIndex);
                
                // Hide all other targets' models
                models.forEach(m => { if (m) m.visible = false; });
                secondModels.forEach(m => { if (m) m.visible = false; });
                
                // Hide first target occluders (they only apply to first target)
                hideFirstTargetOccluders();
                
                // Deactivate other targets
                secondTargetActive = false;
                
                // Initialize third smoothed group position on first detection to prevent initial snap
                if (!thirdTargetFound && thirdSmoothed) {
                    thirdAnchor.group.getWorldPosition(thirdSmoothed.position);
                    thirdAnchor.group.getWorldQuaternion(thirdSmoothed.quaternion);
                    thirdAnchor.group.getWorldScale(thirdSmoothed.scale);
                }
                
                thirdTargetActive = true;
                thirdTargetFound = true;
                // Show HUD for navigation
                hud.hidden = false;
                thirdUpdateLabel();
                thirdUpdateNavigationButtons();
                
                // Trigger composite sequence if on composite slot
                if (thirdSlotControllers[thirdIndex] && thirdSlotControllers[thirdIndex].isComposite && !thirdSlotControllers[thirdIndex].started) {
                    thirdSlotControllers[thirdIndex].startSequenceIfReady();
                }
                
                showThirdTargetContent();
            };
            
            thirdAnchor.onTargetLost = () => {
                if (thirdTargetActive) {
                    console.log('Third target lost.');
                    thirdTargetActive = false;
                    thirdTargetFound = false;
                    // Only hide HUD if no other target is active
                    if (!targetFound && !secondTargetActive) {
                        hud.hidden = true;
                    }
                    hideThirdTargetContent();
                }
            };
        }
        
        // Load all third target scenes (3 building scenes)
        function loadThirdTargetScenes() {
            console.log('Loading third target (building) scenes...');
            
            // Third Target Scene 1 - Building Scene 1
            thirdLoadComposite(0, [
                "./applications-20230306/applications/assets/DataModel11_3/kup.gltf", 
            ], 
            [0],     // Timing: appears immediately
            [0]);    // hideAfter: stays forever
            
            // Third Target Scene 2 - Building Scene 2
            thirdLoadComposite(1, [
                // Add your third target scene 2 models here
            ], 
            [0],     // Timing: appears immediately
            [0]);    // hideAfter: stays forever
            
            // Third Target Scene 3 - Building Scene 3
            thirdLoadComposite(2, [
                // Add your third target scene 3 models here
            ], 
            [0],     // Timing: appears immediately
            [0]);    // hideAfter: stays forever
        }
        
        // Show content for third target
        function showThirdTargetContent() {
            console.log('Displaying third target composite scenes...');
            console.log('[Target 3] Current scene index:', thirdIndex);
            console.log('[Target 3] Scene model exists:', !!thirdModels[thirdIndex]);
            // Ensure other targets' models are hidden
            models.forEach(m => { if (m) m.visible = false; });
            secondModels.forEach(m => { if (m) m.visible = false; });
            // Show the current scene on third target
            thirdApplyVisibility();
        }
        
        // Hide third target content
        function hideThirdTargetContent() {
            console.log('Hiding third target content...');
            // Hide all third target models
            thirdModels.forEach(m => { if (m) m.visible = false; });
        }
        
        
        // Show message when targets found but not ready
        function showNotReadyMessage() {
            const message = document.createElement('div');
            message.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(255, 165, 0, 0.9);
                color: white;
                padding: 20px;
                border-radius: 8px;
                font-family: system-ui;
                font-size: 16px;
                text-align: center;
                z-index: 10000;
            `;
            message.innerHTML = `
                <p>⚠️ Complete the first target first!</p>
                <p>Scan the first target and complete all scenes.</p>
            `;
            document.body.appendChild(message);
            
            setTimeout(() => {
                if (message.parentNode) {
                    message.parentNode.removeChild(message);
                }
            }, 3000);
        }

        // Show message prompting user to scan second target
        function showScanSecondTargetMessage() {
            const message = document.createElement('div');
            message.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(46, 204, 113, 0.95);
                color: white;
                padding: 25px;
                border-radius: 12px;
                font-family: system-ui;
                font-size: 18px;
                text-align: center;
                z-index: 10000;
                box-shadow: 0 8px 24px rgba(0,0,0,0.3);
            `;
            message.innerHTML = `
                <p style="font-size: 24px; margin: 0 0 10px 0;">✅ First Target Complete!</p>
                <p style="margin: 10px 0;">Now scan the <strong>second target</strong> to continue</p>
            `;
            document.body.appendChild(message);
            
            setTimeout(() => {
                if (message.parentNode) {
                    message.parentNode.removeChild(message);
                }
            }, 4000);
        }
        
        // Show message when third target found but not ready
        function showNotReadyForThirdTargetMessage() {
            const message = document.createElement('div');
            message.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(255, 165, 0, 0.9);
                color: white;
                padding: 20px;
                border-radius: 8px;
                font-family: system-ui;
                font-size: 16px;
                text-align: center;
                z-index: 10000;
            `;
            message.innerHTML = `
                <p>⚠️ Complete the first two targets first!</p>
                <p>Complete all scenes from Target 1 and Target 2.</p>
            `;
            document.body.appendChild(message);
            
            setTimeout(() => {
                if (message.parentNode) {
                    message.parentNode.removeChild(message);
                }
            }, 3000);
        }

        // ============ LOAD OCCLUDERS (for FIRST target only) ============
        // Array to track all occluders for visibility management
        const firstTargetOccluders = [];
        
        // Helper functions to show/hide first target occluders
        function showFirstTargetOccluders() {
            firstTargetOccluders.forEach(occ => { if (occ) occ.visible = true; });
            console.log('[OCCLUDER] First target occluders shown');
        }
        
        function hideFirstTargetOccluders() {
            firstTargetOccluders.forEach(occ => { if (occ) occ.visible = false; });
            console.log('[OCCLUDER] First target occluders hidden');
        }
        
        // Occluder 1 - Closest/Shortest buildings
        loader.load(
            "./applications-20230306/applications/assets/DataModel11_3/GhostBina1.gltf",
            (gltf) => {
                const ghostScene = gltf.scene;
                ghostScene.position.set(0, 0, 0);
                ghostScene.rotation.set(0, 0, 0);
                ghostScene.name = 'occluder-ghost1';
                prepOccluder(ghostScene);        // make it "ghost"
                smoothed.add(ghostScene);        // Add to smoothed group for consistent positioning
                ghostScene.visible = true;
                firstTargetOccluders.push(ghostScene);
                console.log("[OCCLUDER] Ghost1 (closest layer) loaded on first target");
            },
            undefined,
            (err) => console.error("[GLTF] ghost1 load error:", err)
        );

        // Occluder 2 - Middle depth buildings
        loader.load(
            "./applications-20230306/applications/assets/DataModel11_3/GhostBina2.gltf",
            (gltf) => {
                const ghostScene = gltf.scene;
                ghostScene.position.set(0, 0, 0);
                ghostScene.rotation.set(0, 0, 0);
                ghostScene.name = 'occluder-ghost2';
                prepOccluder(ghostScene);        // make it "ghost"
                smoothed.add(ghostScene);        // Add to smoothed group for consistent positioning
                ghostScene.visible = true;
                firstTargetOccluders.push(ghostScene);
                console.log("[OCCLUDER] Ghost2 (middle layer) loaded on first target");
            },
            undefined,
            (err) => console.error("[GLTF] ghost2 load error:", err)
        );

        // Occluder 3 - Furthest/Tallest buildings
        loader.load(
            "./applications-20230306/applications/assets/DataModel11_3/GhostBina3.gltf",
            (gltf) => {
                const ghostScene = gltf.scene;
                ghostScene.position.set(0, 0, 0);
                ghostScene.rotation.set(0, 0, 0);
                ghostScene.name = 'occluder-ghost3';
                prepOccluder(ghostScene);        // make it "ghost"
                smoothed.add(ghostScene);        // Add to smoothed group for consistent positioning
                ghostScene.visible = true;
                firstTargetOccluders.push(ghostScene);
                console.log("[OCCLUDER] Ghost3 (furthest layer) loaded on first target");
            },
            undefined,
            (err) => console.error("[GLTF] ghost3 load error:", err)
        );

        // Occluder 4 - Additional depth layer (sun/gunes)
        loader.load(
            "./applications-20230306/applications/assets/DataModel11_3/Ghostgunes.gltf",
            (gltf) => {
                console.log("[OCCLUDER] Ghostgunes.gltf loaded successfully");
                const ghostScene = gltf.scene;
                ghostScene.position.set(0, 0, 0);
                ghostScene.rotation.set(0, 0, 0);
                ghostScene.name = 'occluder-ghostgunes';
                prepOccluder(ghostScene);        // make it "ghost"
                smoothed.add(ghostScene);        // Add to smoothed group for consistent positioning
                ghostScene.visible = true;
                firstTargetOccluders.push(ghostScene);
                console.log("[OCCLUDER] Ghost4 (gunes/sun layer) added to scene - visible:", ghostScene.visible);
                console.log("[OCCLUDER] Ghost4 in smoothed group:", smoothed.children.includes(ghostScene));
                console.log("[OCCLUDER] Total occluders loaded:", firstTargetOccluders.length);
            },
            (progress) => {
                // Log loading progress
                if (progress.lengthComputable) {
                    const percentComplete = (progress.loaded / progress.total) * 100;
                    console.log(`[OCCLUDER] Ghostgunes loading: ${percentComplete.toFixed(0)}%`);
                }
            },
            (err) => {
                console.error("[GLTF] ghost4 (Ghostgunes) load error:", err);
                console.error("[GLTF] Error details:", err.message, err.stack);
            }
        );


        // ============ LOAD YOUR MODELS (per-model transforms) ============

        function register(obj, slot) {
            obj.visible = false;              // avoid a flash before we choose
            smoothed.add(obj);                // attach to smoothed group instead of anchor.group
            models[slot] = obj;               // place into fixed slot
            applyVisibility();
        }
        
        // Second smoothed group (for middle target - will be created when second anchor is initialized)
        let secondSmoothed = null;
        
        // Third smoothed group (for building target - will be created when third anchor is initialized)
        let thirdSmoothed = null;
        
        // Register function for second target
        function secondRegister(obj, slot) {
            obj.visible = false;
            if (secondSmoothed) {
                secondSmoothed.add(obj);      // attach to second smoothed group
            }
            secondModels[slot] = obj;
            secondApplyVisibility();
        }
        
        // Register function for third target
        function thirdRegister(obj, slot) {
            obj.visible = false;
            if (thirdSmoothed) {
                thirdSmoothed.add(obj);       // attach to third smoothed group
            }
            thirdModels[slot] = obj;
            thirdApplyVisibility();
        }




        // composite slot — multiple GLTFs in one scene, with sequential reveals
        // files: array of file paths (order = reveal order)
        // timing: array of absolute times in milliseconds (when each part should appear, first part at 0)
        // hideAfter: array of durations in milliseconds (how long each part stays visible, 0 = stays forever)
        function loadComposite(
            slot,
            files,
            timing, // array of absolute times in ms, e.g. [0, 2000, 5000] means: part0 at 0ms, part1 at 2000ms, part2 at 5000ms
            hideAfter, // array of durations in ms, e.g. [3000, 0, 0] means: part0 hides after 3s, part1&2 stay forever
            { resetOnLeave=true, exclusive=false, resetOnEnter=true } = {}
        ) {
            const group = new THREE.Group();
            group.name = `composite-slot-${slot}`;
            register(group, slot);

            const parts = [];            // roots per part (in reveal order)
            let timers = [];
            let allLoaded = 0;

            const clearTimers = () => { timers.forEach(id => clearTimeout(id)); timers = []; };


            function hidePart(i) {
                const p = parts[i];
                if (!p) return;
                
                console.log(`Hiding part ${i} after ${hideAfter[i]}ms`);
                p.visible = false;
                
                // Stop animations for this part
                stopAnimationsForPart(p);
                
                // Update navigation buttons after hiding part
                updateNavigationButtons();
            }

            function revealPart(i) {
                if (exclusive) parts.forEach((p, j) => { if (p) p.visible = (j === i); });

                const p = parts[i];
                if (!p) return;

                console.log(`Revealing part ${i}`);
                p.visible = true;

                // Start animations for this part
                startAnimationsForPart(p);

                // Set up auto-hide timer if specified
                if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                    const hideTimer = setTimeout(() => {
                        hidePart(i);
                    }, hideAfter[i]);
                    timers.push(hideTimer);
                    console.log(`Scheduled part ${i} to hide after ${hideAfter[i]}ms`);
                } else {
                    // This is a permanent part (hideAfter = 0), check if navigation should be enabled
                    console.log(`Part ${i} is permanent, checking navigation...`);
                }
                
                // Update navigation buttons after revealing part
                updateNavigationButtons();
            }

            function startSequence() {
                if (slotControllers[slot].started) return;  // already started
                if (allLoaded < files.length) {
                    console.log(`Cannot start sequence: ${files.length - allLoaded} parts still loading`);
                    return;  // wait for all loaded
                }
                
                console.log(`Starting composite sequence with ${files.length} parts`);
                slotControllers[slot].started = true;
                clearTimers();
                
                // Normalize timing so that time zero is when the FIRST part appears
                const firstTime = (Array.isArray(timing) && timing.length > 0) ? (timing[0] || 0) : 0;
                files.forEach((_, i) => {
                    const absoluteTime = timing[i] || 0;
                    const relativeTime = Math.max(0, absoluteTime - firstTime);
                    const id = setTimeout(() => {
                        console.log(`Revealing part ${i} at ${relativeTime}ms (relative to first part at ${firstTime}ms)`);
                        revealPart(i);
                    }, relativeTime);
                    timers.push(id);
                });
            }

            function hideAllParts() {
                parts.forEach(p => { 
                    if (p) {
                        p.visible = false;
                        stopAnimationsForPart(p);
                    }
                });
            }

            // Animation handling functions
            function startAnimationsForPart(part) {
                const target = part; // play clips on the root part
                const clips = (target.userData && Array.isArray(target.userData.clips)) ? target.userData.clips : [];
                if (!clips.length) return;

                const mixer = new THREE.AnimationMixer(target);
                target.userData.mixers = target.userData.mixers || [];
                target.userData.mixers.push(mixer);

                clips.forEach((clip) => {
                    const action = mixer.clipAction(clip);
                    action.reset();
                    action.setLoop(THREE.LoopOnce);
                    action.clampWhenFinished = true;
                    action.time = 0;
                    action.enabled = true;
                    action.setEffectiveWeight(1.0);
                    action.fadeIn(0);
                    action.play();
                    console.log(`Started animation: ${clip.name} on composite part root (play once)`);
                });
            }

            function stopAnimationsForPart(part) {
                part.traverse((child) => {
                    if (child.userData.mixers) {
                        child.userData.mixers.forEach(mixer => mixer.stopAllAction());
                        child.userData.mixers = [];
                    }
                });
            }

            // controller hooks for this slot
            slotControllers[slot] = {
                isComposite: true, // Flag to identify this as a composite slot
                started: false, // Track if sequence has started
                
                onEnter() {
                    console.log(`[Target 1] Composite slot ${slot} entered, targetFound: ${targetFound}, allLoaded: ${allLoaded}/${files.length}`);
                    // Ensure other targets' models are hidden
                    secondModels.forEach(m => { if (m) m.visible = false; });
                    thirdModels.forEach(m => { if (m) m.visible = false; });
                    
                    if (resetOnEnter) {
                        clearTimers();
                        hideAllParts();
                        this.started = false;
                    }
                    
                    // Check if target is already found and start sequence immediately
                    if (targetFound && allLoaded >= files.length) {
                        console.log(`Composite slot ${slot} entered with target already found, starting sequence immediately...`);
                        startSequence();
                        this.started = true;
                    } else {
                        console.log(`Composite slot ${slot} entered, waiting for target recognition...`);
                    }
                },
                onLeave() {
                    clearTimers();
                    if (resetOnLeave) { hideAllParts(); }
                    this.started = false;
                },
                startSequenceIfReady() {
                    // Only start if target is found and we haven't started yet
                    if (targetFound && !this.started) {
                        console.log(`Starting composite sequence for slot ${slot} (target found, all ready)`);
                        if (allLoaded >= files.length) {
                            startSequence();
                            this.started = true;
                        } else {
                            console.log(`Waiting for ${files.length - allLoaded} more parts to load...`);
                        }
                    }
                },
                areAllPartsVisible() {
                    // Check if all parts that should STAY visible (hideAfter = 0) are actually visible
                    // Parts with hideAfter > 0 are temporary, so we ignore them for navigation
                    const result = parts.every((part, i) => {
                        if (!part) return true; // If part doesn't exist, consider it "visible"
                        // If this part has auto-hide (hideAfter > 0), don't check its visibility
                        if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                            return true; // Temporary parts don't block navigation
                        }
                        const isVisible = part.visible;
                        if (!isVisible) {
                            console.log(`Slot ${slot}: Permanent part ${i} is not visible yet`);
                        }
                        return isVisible; // Permanent parts must be visible
                    });
                    if (result) {
                        console.log(`✅ Slot ${slot}: All permanent parts are visible! Navigation enabled.`);
                    }
                    return result;
                }
            };

            // load each file; start sequence when all loaded
            files.forEach((path, i) => {
                console.log(`Loading composite part ${i}: ${path}`);
                loader.load(path, (gltf) => {
                    console.log(`Loaded part ${i}: ${path}`);
                    const root = gltf.scene;
                    root.visible = false;
                    root.position.set(0,0,0);
                    root.rotation.set(0,0,0);
                    // Attach animations from the GLTF to the root so we can play them later
                    root.userData = root.userData || {};
                    root.userData.clips = Array.isArray(gltf.animations) ? gltf.animations : [];
                    prepContent(root);     // draw after occluders
                    group.add(root);
                    parts[i] = root;

                    allLoaded++;
                    console.log(`Part ${i} loaded. Total loaded: ${allLoaded}/${files.length}`);
                    // Check if we should start sequence (target found and all loaded)
                    if (models[slot] === group && index === slot && targetFound) {
                        slotControllers[slot].startSequenceIfReady();
                    }
                });
            });
        }

        // ============ LOAD COMPOSITE FOR SECOND TARGET ============
        // Similar to loadComposite but for second target scenes
        function secondLoadComposite(slot, files, timing, hideAfter, { resetOnLeave=true, exclusive=false, resetOnEnter=true } = {}) {
            console.log(`[Target 2] Loading composite slot ${slot} with ${files.length} files`);
            
            const group = new THREE.Group();
            group.name = `second-composite-slot-${slot}`;
            secondRegister(group, slot);

            const parts = [];
            let timers = [];
            let allLoaded = 0;

            const clearTimers = () => { timers.forEach(id => clearTimeout(id)); timers = []; };

            function hidePart(i) {
                const p = parts[i];
                if (!p) return;
                console.log(`[Second Target] Hiding part ${i} after ${hideAfter[i]}ms`);
                p.visible = false;
                stopAnimationsForPart(p);
                
                // Update navigation buttons after hiding part
                secondUpdateNavigationButtons();
            }

            function revealPart(i) {
                if (exclusive) {
                    parts.forEach((p, j) => {
                        if (p) {
                            p.visible = (j === i);
                            if (j !== i) stopAnimationsForPart(p);
                        }
                    });
                }

                const p = parts[i];
                if (!p) return;
                console.log(`[Second Target] Revealing part ${i}`);
                p.visible = true;
                startAnimationsForPart(p);

                if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                    const hideTimer = setTimeout(() => {
                        hidePart(i);
                    }, hideAfter[i]);
                    timers.push(hideTimer);
                    console.log(`[Second Target] Scheduled part ${i} to hide after ${hideAfter[i]}ms`);
                } else {
                    // This is a permanent part (hideAfter = 0), check if navigation should be enabled
                    console.log(`[Second Target] Part ${i} is permanent, checking navigation...`);
                }
                
                // Update navigation buttons after revealing part
                secondUpdateNavigationButtons();
            }

            function startAnimationsForPart(part) {
                const target = part;
                const clips = (target.userData && Array.isArray(target.userData.clips)) ? target.userData.clips : [];
                if (!clips.length) return;

                const mixer = new THREE.AnimationMixer(target);
                target.userData.mixers = target.userData.mixers || [];
                target.userData.mixers.push(mixer);

                clips.forEach((clip) => {
                    const action = mixer.clipAction(clip);
                    action.reset();
                    action.setLoop(THREE.LoopOnce);
                    action.clampWhenFinished = true;
                    action.time = 0;
                    action.enabled = true;
                    action.setEffectiveWeight(1.0);
                    action.fadeIn(0);
                    action.play();
                });
            }

            function stopAnimationsForPart(part) {
                part.traverse((child) => {
                    if (child.userData.mixers) {
                        child.userData.mixers.forEach(mixer => mixer.stopAllAction());
                        child.userData.mixers = [];
                    }
                });
            }

            function startSequence() {
                if (secondSlotControllers[slot].started) return;
                if (allLoaded < files.length) return;
                
                secondSlotControllers[slot].started = true;
                clearTimers();
                
                let cumulativeTime = 0;
                files.forEach((_, i) => {
                    cumulativeTime += timing[i] || 0;
                    const id = setTimeout(() => {
                        revealPart(i);
                    }, cumulativeTime);
                    timers.push(id);
                });
            }

            function hideAllParts() {
                parts.forEach(p => {
                    if (p) {
                        p.visible = false;
                        stopAnimationsForPart(p);
                    }
                });
            }

            secondSlotControllers[slot] = {
                isComposite: true,
                started: false,
                
                onEnter() {
                    console.log(`[Target 2] Scene ${slot} onEnter - ${files.length} files, allLoaded: ${allLoaded}`);
                    // Ensure first target models are hidden
                    models.forEach(m => { if (m) m.visible = false; });
                    
                    if (resetOnEnter) {
                        clearTimers();
                        hideAllParts();
                        this.started = false;
                    }
                    
                    if (secondTargetFound && allLoaded >= files.length) {
                        startSequence();
                        this.started = true;
                    }
                },
                onLeave() {
                    clearTimers();
                    if (resetOnLeave) { hideAllParts(); }
                    this.started = false;
                },
                startSequenceIfReady() {
                    if (secondTargetFound && !this.started) {
                        if (allLoaded >= files.length) {
                            startSequence();
                            this.started = true;
                        }
                    }
                },
                areAllPartsVisible() {
                    // For empty scenes, consider all parts visible
                    if (files.length === 0) return true;
                    
                    // Check if all PERMANENT parts (hideAfter = 0) are visible
                    // Temporary parts (hideAfter > 0) don't block navigation
                    const result = parts.every((part, i) => {
                        if (!part) return true; // If part doesn't exist, consider it "visible"
                        // If this part has auto-hide (hideAfter > 0), don't check its visibility
                        if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                            return true; // Temporary parts don't block navigation
                        }
                        const isVisible = part.visible;
                        if (!isVisible) {
                            console.log(`[Target 2] Slot ${slot}: Permanent part ${i} is not visible yet`);
                        }
                        return isVisible; // Permanent parts must be visible
                    });
                    if (result) {
                        console.log(`✅ [Target 2] Slot ${slot}: All permanent parts are visible! Navigation enabled.`);
                    }
                    return result;
                }
            };

            files.forEach((path, i) => {
                console.log(`[Second Target] Loading composite part ${i}: ${path}`);
                loader.load(path, (gltf) => {
                    console.log(`[Second Target] Loaded part ${i}: ${path}`);
                    const root = gltf.scene;
                    root.visible = false;
                    root.position.set(0,0,0);
                    root.rotation.set(0,0,0);
                    root.userData = root.userData || {};
                    root.userData.clips = Array.isArray(gltf.animations) ? gltf.animations : [];
                    prepContent(root);
                    group.add(root);
                    parts[i] = root;

                    allLoaded++;
                    console.log(`[Second Target] Part ${i} loaded. Total loaded: ${allLoaded}/${files.length}`);
                    if (secondModels[slot] === group && secondIndex === slot && secondTargetFound) {
                        secondSlotControllers[slot].startSequenceIfReady();
                    }
                });
            });
        }

        // ============ LOAD COMPOSITE FOR THIRD TARGET ============
        // Similar to loadComposite but for third target scenes (building)
        function thirdLoadComposite(slot, files, timing, hideAfter, { resetOnLeave=true, exclusive=false, resetOnEnter=true } = {}) {
            const group = new THREE.Group();
            group.name = `third-composite-slot-${slot}`;
            thirdRegister(group, slot);

            const parts = [];
            let timers = [];
            let allLoaded = 0;

            const clearTimers = () => { timers.forEach(id => clearTimeout(id)); timers = []; };

            function hidePart(i) {
                const p = parts[i];
                if (!p) return;
                console.log(`[Third Target] Hiding part ${i} after ${hideAfter[i]}ms`);
                p.visible = false;
                stopAnimationsForPart(p);
                
                // Update navigation buttons after hiding part
                thirdUpdateNavigationButtons();
            }

            function revealPart(i) {
                if (exclusive) {
                    parts.forEach((p, j) => {
                        if (p) {
                            p.visible = (j === i);
                            if (j !== i) stopAnimationsForPart(p);
                        }
                    });
                }

                const p = parts[i];
                if (!p) return;
                console.log(`[Third Target] Revealing part ${i}`);
                p.visible = true;
                startAnimationsForPart(p);

                if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                    const hideTimer = setTimeout(() => {
                        hidePart(i);
                    }, hideAfter[i]);
                    timers.push(hideTimer);
                    console.log(`[Third Target] Scheduled part ${i} to hide after ${hideAfter[i]}ms`);
                } else {
                    // This is a permanent part (hideAfter = 0), check if navigation should be enabled
                    console.log(`[Third Target] Part ${i} is permanent, checking navigation...`);
                }
                
                // Update navigation buttons after revealing part
                thirdUpdateNavigationButtons();
            }

            function startAnimationsForPart(part) {
                const target = part;
                const clips = (target.userData && Array.isArray(target.userData.clips)) ? target.userData.clips : [];
                if (!clips.length) return;

                const mixer = new THREE.AnimationMixer(target);
                target.userData.mixers = target.userData.mixers || [];
                target.userData.mixers.push(mixer);

                clips.forEach((clip) => {
                    const action = mixer.clipAction(clip);
                    action.reset();
                    action.setLoop(THREE.LoopOnce);
                    action.clampWhenFinished = true;
                    action.time = 0;
                    action.enabled = true;
                    action.setEffectiveWeight(1.0);
                    action.fadeIn(0);
                    action.play();
                });
            }

            function stopAnimationsForPart(part) {
                part.traverse((child) => {
                    if (child.userData.mixers) {
                        child.userData.mixers.forEach(mixer => mixer.stopAllAction());
                        child.userData.mixers = [];
                    }
                });
            }

            function startSequence() {
                if (thirdSlotControllers[slot].started) return;
                if (allLoaded < files.length) return;
                
                thirdSlotControllers[slot].started = true;
                clearTimers();
                
                let cumulativeTime = 0;
                files.forEach((_, i) => {
                    cumulativeTime += timing[i] || 0;
                    const id = setTimeout(() => {
                        revealPart(i);
                    }, cumulativeTime);
                    timers.push(id);
                });
            }

            function hideAllParts() {
                parts.forEach(p => {
                    if (p) {
                        p.visible = false;
                        stopAnimationsForPart(p);
                    }
                });
            }

            thirdSlotControllers[slot] = {
                isComposite: true,
                started: false,
                
                onEnter() {
                    console.log(`[Target 3] Scene ${slot} onEnter - ${files.length} files, allLoaded: ${allLoaded}`);
                    // Ensure other targets' models are hidden
                    models.forEach(m => { if (m) m.visible = false; });
                    secondModels.forEach(m => { if (m) m.visible = false; });
                    
                    if (resetOnEnter) {
                        clearTimers();
                        hideAllParts();
                        this.started = false;
                    }
                    
                    if (thirdTargetFound && allLoaded >= files.length) {
                        startSequence();
                        this.started = true;
                    }
                },
                onLeave() {
                    clearTimers();
                    if (resetOnLeave) { hideAllParts(); }
                    this.started = false;
                },
                startSequenceIfReady() {
                    if (thirdTargetFound && !this.started) {
                        if (allLoaded >= files.length) {
                            startSequence();
                            this.started = true;
                        }
                    }
                },
                areAllPartsVisible() {
                    // For empty scenes, consider all parts visible
                    if (files.length === 0) return true;
                    
                    // Check if all PERMANENT parts (hideAfter = 0) are visible
                    // Temporary parts (hideAfter > 0) don't block navigation
                    const result = parts.every((part, i) => {
                        if (!part) return true; // If part doesn't exist, consider it "visible"
                        // If this part has auto-hide (hideAfter > 0), don't check its visibility
                        if (hideAfter && hideAfter[i] && hideAfter[i] > 0) {
                            return true; // Temporary parts don't block navigation
                        }
                        const isVisible = part.visible;
                        if (!isVisible) {
                            console.log(`[Target 3] Slot ${slot}: Permanent part ${i} is not visible yet`);
                        }
                        return isVisible; // Permanent parts must be visible
                    });
                    if (result) {
                        console.log(`✅ [Target 3] Slot ${slot}: All permanent parts are visible! Navigation enabled.`);
                    }
                    return result;
                }
            };

            files.forEach((path, i) => {
                console.log(`[Third Target] Loading composite part ${i}: ${path}`);
                loader.load(path, (gltf) => {
                    console.log(`[Third Target] Loaded part ${i}: ${path}`);
                    const root = gltf.scene;
                    root.visible = false;
                    root.position.set(0,0,0);
                    root.rotation.set(0,0,0);
                    root.userData = root.userData || {};
                    root.userData.clips = Array.isArray(gltf.animations) ? gltf.animations : [];
                    prepContent(root);
                    group.add(root);
                    parts[i] = root;

                    allLoaded++;
                    console.log(`[Third Target] Part ${i} loaded. Total loaded: ${allLoaded}/${files.length}`);
                    if (thirdModels[slot] === group && thirdIndex === slot && thirdTargetFound) {
                        thirdSlotControllers[slot].startSequenceIfReady();
                    }
                });
            });
        }

        // --- Slots (TOTAL = 3) ---
        

        // Slot 1: COMPOSITE of three files, revealed 3s apart (accumulating)

        // ============ LOAD SCENES ============
        // Scene 1: Single model


        loadComposite(0, [
            
            //gunes
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.1/gunes.gltf",   
            //soru
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.1/Soru1.1.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.1/Soru1.2.gltf", 
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.1/Soru1.3.gltf", 
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.1/Soru1.4.gltf",  

            //mevcut
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.1/Bina.gltf",

            //çerçeve
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-1.gltf", 
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-2.gltf",          
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-3.gltf",          
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-4.gltf",          
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-5.gltf",          
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-6.gltf",          
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-7.gltf", 
            //enerji işaret
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/Simsek1.gltf", 
            //Enerji işaret azalma            
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/Simsek2.gltf", 
            //sahne1.2
            //ışık yanması
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.2/Pencere1.gltf", 
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.2/Pencere2.gltf",    
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.2/Pencere3.gltf",    
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.2/Pencere4.gltf",    
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.2/Pencere5.gltf",    
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.2/Pencere6.gltf",    
                     
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-8.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-9.gltf",          
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-10.gltf",          
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/BarV2-11.gltf",
            //Enerji işaret azalma            
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/Simsek3.gltf", 
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.3/Simsek4.gltf", 

            //sahne1.4
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.4/Pencere1.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne1.4/Pencere2.gltf",                   

        ],  [0,
            2000, 2750, 3500, 4250,
            0,
            5000, 5167, 5667, 5834, 6334, 6834, 8001, 
            8001, 12000,
            12000, 12750, 13500, 14250, 15000, 15750, 
            16000, 16500, 18500, 18833,
            16500, 20000,
            20000, 21000], 
            
            [0,
            0,0,0,0,
            0,
            0, 0, 0, 0, 0, 0, 0,
            3999, 4500,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 
            3500, 0,
            0, 0], {

            exclusive: false,
            resetOnLeave: true,
            resetOnEnter: true
        });

        loadComposite(1, [
            //sahne2.1 mevcut           
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/mevcut.gltf", 
            //gunes
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/gunes.gltf",   
            //soru
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/Soru1.1.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/Soru1.2.gltf", 
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/Soru1.3.gltf", 
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/Soru1.4.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/Soru1.5.gltf",  

            //elektrik üretim
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Simsek1.gltf",
            //barlar
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-1.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-2.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-5.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-6.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-7.gltf",
            //sahne2.1 kapanacak binalar
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup1.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup2.gltf", 
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup5.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup6.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup7.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.1/kapanacak/BinaGrup9.gltf",
            //sahne2.2 açılacak binalar
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup1.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup2.gltf",     
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup5.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup6.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup7.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/acilacakbina/BinaGrup9.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Simsek2.gltf",            

            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere1.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere2.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere5.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere6.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere7.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere9.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.2/MevcutPencere/Pencere10.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-9.gltf",        
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-10.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/BarV2-11.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Simsek3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Simsek4.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere1.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere2.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere5.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere6.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere7.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere9.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere10.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere11.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere12.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere13.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere14.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne2.3/Pencere/Pencere15.gltf",


        ], 
        
        // Timing array - when each part appears
        [   0,  //mevcut
            0, //gunes
            1000, 1750, 2500, 3250, 4000,//soru
            5000, // elektrik üretim
            5000, 5833, 6000, 6167, 7167, 8834, 10001,//çerçeve
            0, 0, 0, 0, 0, 0, 0, 0, 0,//kapanacakbina
            5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500, 9000, //açılacakbina
            11000, //kullanılan enerji
            11000, 11500, 12000, 12500, 13000, 13500, 14000, 14500, 15000, 15500,//mevcutpencere
            16000, 16500, 20500, 20834,
            16500, 20000,
            21000, 21250, 21500, 21750, 22000, 22250, 22500, 22750, 23000, 23250, 23500, 23750, 24000, 24250, 24500,
        ], 
        
        // HideAfter array - how long each part stays (0 = forever)
        [   0,  //mevcut
            0, //gunes
            0, 0, 0, 0, 0,
            6000,
            0, 0, 0, 0, 0, 0, 0,
            5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500, 9000, 
            0, 0, 0, 0, 0, 0, 0, 0, 0,
            5500,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0,
            4000, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ], {

            exclusive: false,
            resetOnLeave: true,
            resetOnEnter: true
        });

        loadComposite(2, [
            //gunes
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/gunes.gltf", 

            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Soru1.1.gltf",   
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Soru1.2.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Soru1.3.gltf",  
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Soru1.4.gltf",  


            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.4/Simsek1.gltf",    

            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup1.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup2.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup5.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup6.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup7.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup9.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.1/Kapanacak/BinaGrup10.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup1.gltf",           
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup2.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup5.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup6.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup7.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup9.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Acilacak/BinaGrup10.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.3/BarV2-1.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.3/BarV2-2.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.3/BarV2-3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.3/BarV2-4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.3/BarV2-5.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.4/Simsek2.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup1.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup2.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup3.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup4.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup5.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup6.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup7.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup9.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.2/Pencere/PencereGrup10.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.4/BarV2-6.gltf",   
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.4/BarV2-7.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.4/BarV2-8.gltf",
            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.4/BarV2-9.gltf",

            "./applications-20230306/applications/assets/DataModel11_3/Sahne3.4/Simsek3.gltf",

              
        ], [0,
            1000, 1750, 2500, 3250,
            4000,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500,
            4000, 5000, 6167, 7834, 9001, 
            10000,
            10000, 10500, 11000, 11500, 12000, 12500, 13000, 13500, 14000, 14500,
            15000, 15500, 15500, 19666,
            15500,

            ],

            [0,
            0, 0, 0, 0,  
            6000,   
            4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0,
            5500,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0,
            0,

            ], {

            exclusive: false,
            resetOnLeave: true,
            resetOnEnter: true
        });


        // Create text sprite for AR instructions (shared by second target guide)
        function createTextSprite(text, parentGroup) {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = 512;
            canvas.height = 256;
            
            // Draw text
            context.fillStyle = 'rgba(0, 0, 0, 0.8)';
            context.fillRect(0, 0, canvas.width, canvas.height);
            
            context.font = 'bold 40px Arial';
            context.fillStyle = 'white';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            
            // Split text by newlines and draw each line
            const lines = text.split('\n');
            const lineHeight = 50;
            const startY = (canvas.height - (lines.length - 1) * lineHeight) / 2;
            
            lines.forEach((line, i) => {
                context.fillText(line, canvas.width / 2, startY + i * lineHeight);
            });
            
            // Create texture from canvas
            const texture = new THREE.CanvasTexture(canvas);
            const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
            const sprite = new THREE.Sprite(material);
            
            sprite.scale.set(0.25, 0.125, 1);
            sprite.position.set(0, -0.15, 0); // Below the line drawing
            
            parentGroup.add(sprite);
        }
        
        // NOTE: Second target (middle) is initialized when user completes first target
        // Third target (building) is initialized when reaching second target scene 3 (guide)
        // This optimizes performance by not tracking targets until needed

        // ============ START ============
        // ============ START AR ============
        await mindarThree.start();
        
        // NOTE: Second anchor initializes when user clicks next after completing first target
        // Third anchor initializes when reaching second target scene 3 (guide scene)
        
        // Animation mixer for updating animations
        const clock = new THREE.Clock();
        
        // Constant smoothing parameter - applied at all distances
        // Lower value = smoother but slightly more lag
        // Higher value = more responsive but more jitter
        const smoothingAlpha = 0.08; // Optimized balance: minimal jitter with acceptable lag
        
        // Helper matrices and vectors for world transform extraction
        const anchorWorldPosition = new THREE.Vector3();
        const anchorWorldQuaternion = new THREE.Quaternion();
        const anchorWorldScale = new THREE.Vector3();
        
        const secondAnchorWorldPosition = new THREE.Vector3();
        const secondAnchorWorldQuaternion = new THREE.Quaternion();
        const secondAnchorWorldScale = new THREE.Vector3();
        
        const thirdAnchorWorldPosition = new THREE.Vector3();
        const thirdAnchorWorldQuaternion = new THREE.Quaternion();
        const thirdAnchorWorldScale = new THREE.Vector3();
        
        renderer.setAnimationLoop(() => {
            const delta = Math.min(clock.getDelta(), 0.1); // Cap delta to prevent large jumps
            
            // Apply constant smoothing to first target
            if (targetFound) {
                // Extract world transform from anchor
                anchor.group.getWorldPosition(anchorWorldPosition);
                anchor.group.getWorldQuaternion(anchorWorldQuaternion);
                anchor.group.getWorldScale(anchorWorldScale);
                
                // Smoothly interpolate smoothed group to match anchor's world transform
                smoothed.position.lerp(anchorWorldPosition, smoothingAlpha);
                smoothed.quaternion.slerp(anchorWorldQuaternion, smoothingAlpha);
                smoothed.scale.lerp(anchorWorldScale, smoothingAlpha);
            }
            
            // Apply constant smoothing to second target (middle target)
            if (secondTargetFound && secondSmoothed && secondAnchor) {
                // Extract world transform from second anchor
                secondAnchor.group.getWorldPosition(secondAnchorWorldPosition);
                secondAnchor.group.getWorldQuaternion(secondAnchorWorldQuaternion);
                secondAnchor.group.getWorldScale(secondAnchorWorldScale);
                
                // Smoothly interpolate second smoothed group to match second anchor's world transform
                secondSmoothed.position.lerp(secondAnchorWorldPosition, smoothingAlpha);
                secondSmoothed.quaternion.slerp(secondAnchorWorldQuaternion, smoothingAlpha);
                secondSmoothed.scale.lerp(secondAnchorWorldScale, smoothingAlpha);
            }
            
            // Apply constant smoothing to third target (building target)
            if (thirdTargetFound && thirdSmoothed && thirdAnchor) {
                // Extract world transform from third anchor
                thirdAnchor.group.getWorldPosition(thirdAnchorWorldPosition);
                thirdAnchor.group.getWorldQuaternion(thirdAnchorWorldQuaternion);
                thirdAnchor.group.getWorldScale(thirdAnchorWorldScale);
                
                // Smoothly interpolate third smoothed group to match third anchor's world transform
                thirdSmoothed.position.lerp(thirdAnchorWorldPosition, smoothingAlpha);
                thirdSmoothed.quaternion.slerp(thirdAnchorWorldQuaternion, smoothingAlpha);
                thirdSmoothed.scale.lerp(thirdAnchorWorldScale, smoothingAlpha);
            }
            
            // Update all animation mixers for first target
            models.forEach(model => {
                if (model && model.visible) { // Only update visible models
                    model.traverse((child) => {
                        if (child.userData.mixers) {
                            child.userData.mixers.forEach(mixer => {
                                mixer.update(delta);
                            });
                        }
                    });
                }
            });
            
            // Update all animation mixers for second target
            secondModels.forEach(model => {
                if (model && model.visible) { // Only update visible models
                    model.traverse((child) => {
                        if (child.userData.mixers) {
                            child.userData.mixers.forEach(mixer => {
                                mixer.update(delta);
                            });
                        }
                    });
                }
            });
            
            // Update all animation mixers for third target
            thirdModels.forEach(model => {
                if (model && model.visible) { // Only update visible models
                    model.traverse((child) => {
                        if (child.userData.mixers) {
                            child.userData.mixers.forEach(mixer => {
                                mixer.update(delta);
                            });
                        }
                    });
                }
            });
            
            renderer.render(scene, camera);
        });

        // Debug helper - expose to global scope for testing
        window.debugAR = {
            testCompositeSlots: () => {
                console.log('Testing composite slots...');
                if (slotControllers[1]) {
                    console.log('Triggering composite slot onEnter...');
                    slotControllers[1].onEnter();
                }
            },
            getSlotState: () => {
                console.log('Current slot state:');
                console.log('Active slot:', index);
                console.log('Slot controllers:', slotControllers.map((c, i) => ({ slot: i, hasController: !!c })));
            }
        };

        // ---------- helpers ----------
        function createHUD() {
            const hud = document.createElement('div');
            hud.className = 'hud';
            hud.id = 'hud';
            hud.hidden = true;
            hud.innerHTML = `
                <button id="prev" class="arrow" aria-label="Previous">◀</button>
                <div class="label" id="label">0/0</div>
                <button id="replay" class="arrow replay-btn" aria-label="Replay">↻</button>
                <button id="next" class="arrow" aria-label="Next">▶</button>
            `;
            document.body.appendChild(hud);
            return {
                hud,
                prevB: hud.querySelector('#prev'),
                nextB: hud.querySelector('#next'),
                replayB: hud.querySelector('#replay'),
                label: hud.querySelector('#label')
            };
        }

        function injectHUDStyles() {
            const css = `
                #ar-container { position: fixed; inset: 0; background: #000; }
                .hud {
                position: fixed;
                left: 0; right: 0;
                bottom: max(env(safe-area-inset-bottom), 16px);
                display: flex; gap: 12px; justify-content: center; align-items: center;
                pointer-events: none; /* let taps pass EXCEPT on buttons */
                font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
                z-index: 9999;
                }
                .hud .arrow {
                pointer-events: auto;
                border: 0; border-radius: 999px; padding: 12px 16px;
                font-size: 18px; background: rgba(255,255,255,.92);
                box-shadow: 0 6px 18px rgba(0,0,0,.25);
                transition: opacity 0.3s ease, transform 0.2s ease;
                cursor: pointer;
                }
                .hud .arrow:hover:not(:disabled) {
                transform: scale(1.05);
                background: rgba(255,255,255,1);
                }
                .hud .arrow:active:not(:disabled) {
                transform: scale(0.95);
                }
                .hud .replay-btn {
                font-size: 20px;
                font-weight: bold;
                background: rgba(52, 152, 219, 0.92);
                color: white;
                }
                .hud .replay-btn:hover:not(:disabled) {
                background: rgba(52, 152, 219, 1);
                }
                .hud .arrow:disabled {
                pointer-events: none;
                cursor: not-allowed;
                }
                .hud .arrow:disabled:hover {
                transform: none;
                }
                .hud .label {
                pointer-events: none; color: #fff; font-weight: 700;
                text-shadow: 0 2px 8px rgba(0,0,0,.6);
                }
                canvas { touch-action: none; } /* improves mobile pointer behavior */
            `;
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }        
    }
    start();
});
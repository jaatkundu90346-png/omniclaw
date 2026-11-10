/* ============================================
   OmniClaw AI — Interactive 3D Landing Page
   Three.js | Particles | Parallax | Animations
   ============================================ */

// ============================================
// THREE.JS 3D SCENE
// ============================================
let scene, camera, renderer, torusKnot, particleSystem;
let mouseX = 0, mouseY = 0;
let targetMouseX = 0, targetMouseY = 0;
const windowHalfX = window.innerWidth / 2;
const windowHalfY = window.innerHeight / 2;

function initThreeJS() {
    const container = document.getElementById('three-canvas');
    if (!container) return;

    // Scene setup
    scene = new THREE.Scene();
    // Transparent background to show CSS gradient
    
    // Camera
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 4;

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // Create glowing torus knot
    const geometry = new THREE.TorusKnotGeometry(0.8, 0.25, 150, 20, 2, 3);
    const material = new THREE.MeshStandardMaterial({
        color: 0x00f0ff,
        emissive: 0x00f0ff,
        emissiveIntensity: 0.8,
        metalness: 0.7,
        roughness: 0.2,
        transparent: true,
        opacity: 0.9
    });
    torusKnot = new THREE.Mesh(geometry, material);
    scene.add(torusKnot);

    // Add multiple lights for glow effect
    const ambientLight = new THREE.AmbientLight(0x404040, 1.5);
    scene.add(ambientLight);

    const pointLight1 = new THREE.PointLight(0x00f0ff, 2, 50);
    pointLight1.position.set(5, 5, 5);
    scene.add(pointLight1);

    const pointLight2 = new THREE.PointLight(0xa855f7, 2, 50);
    pointLight2.position.set(-5, -5, 5);
    scene.add(pointLight2);

    const pointLight3 = new THREE.PointLight(0xec4899, 1.5, 50);
    pointLight3.position.set(0, 5, -5);
    scene.add(pointLight3);

    // Particle system
    const particleCount = 2000;
    const particles = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const sizes = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
        // Position
        positions[i * 3] = (Math.random() - 0.5) * 20;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 20;

        // Colors - mix of cyan, purple, and pink
        const colorChoice = Math.random();
        if (colorChoice < 0.33) {
            colors[i * 3] = 0; colors[i * 3 + 1] = 0.94; colors[i * 3 + 2] = 1; // Cyan
        } else if (colorChoice < 0.66) {
            colors[i * 3] = 0.66; colors[i * 3 + 1] = 0.33; colors[i * 3 + 2] = 1; // Purple
        } else {
            colors[i * 3] = 0.92; colors[i * 3 + 1] = 0.28; colors[i * 3 + 2] = 0.6; // Pink
        }

        // Size variation
        sizes[i] = Math.random() * 2 + 0.5;
    }

    particles.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particles.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    particles.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const particleMaterial = new THREE.PointsMaterial({
        size: 0.03,
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
    });

    particleSystem = new THREE.Points(particles, particleMaterial);
    scene.add(particleSystem);

    // Mouse move for parallax
    document.addEventListener('mousemove', onDocumentMouseMove);
    
    // Resize handler
    window.addEventListener('resize', onWindowResize);
}

function onDocumentMouseMove(event) {
    targetMouseX = (event.clientX - windowHalfX) / windowHalfX;
    targetMouseY = (event.clientY - windowHalfY) / windowHalfY;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animateThreeJS() {
    requestAnimationFrame(animateThreeJS);

    if (!torusKnot || !particleSystem) return;

    // Smooth mouse interpolation
    mouseX += (targetMouseX - mouseX) * 0.05;
    mouseY += (targetMouseY - mouseY) * 0.05;

    // Rotate torus knot
    torusKnot.rotation.x += 0.003;
    torusKnot.rotation.y += 0.005;
    
    // Mouse parallax on torus
    torusKnot.position.x = mouseX * 0.5;
    torusKnot.position.y = -mouseY * 0.5;

    // Animate particles
    const positions = particleSystem.geometry.attributes.position.array;
    const time = Date.now() * 0.0005;
    
    for (let i = 0; i < positions.length; i += 3) {
        // Gentle floating motion
        positions[i] += Math.sin(time + i) * 0.0003;
        positions[i + 1] += Math.cos(time + i) * 0.0003;
        positions[i + 2] += Math.sin(time * 0.5 + i) * 0.0002;
        
        // Wrap around for infinite effect
        if (positions[i] > 10) positions[i] = -10;
        if (positions[i] < -10) positions[i] = 10;
        if (positions[i + 1] > 10) positions[i + 1] = -10;
        if (positions[i + 1] < -10) positions[i + 1] = 10;
    }
    particleSystem.geometry.attributes.position.needsUpdate = true;

    // Rotate entire particle system slowly
    particleSystem.rotation.y += 0.0003;
    particleSystem.rotation.x += 0.0001;

    // Camera parallax
    camera.position.x += (mouseX * 0.5 - camera.position.x) * 0.02;
    camera.position.y += (-mouseY * 0.5 - camera.position.y) * 0.02;
    camera.lookAt(scene.position);

    renderer.render(scene, camera);
}

// ============================================
// SCROLL REVEAL ANIMATIONS
// ============================================
function initScrollReveal() {
    const revealElements = document.querySelectorAll(
        '.section-header, .problem-card, .feature-card, .workflow-step, .pricing-card, .demo-panel'
    );
    
    const checkIfInView = () => {
        const triggerBottom = window.innerHeight * 0.85;
        
        revealElements.forEach((el, index) => {
            const rect = el.getBoundingClientRect().top;
            if (rect < triggerBottom) {
                // Add staggered delay
                setTimeout(() => {
                    el.classList.add('revealed');
                }, index * 100);
            }
        });
    };

    window.addEventListener('scroll', checkIfInView);
    checkIfInView(); // Initial check
}

// ============================================
// MOBILE NAVIGATION
// ============================================
function initMobileNav() {
    const mobileToggle = document.getElementById('mobileToggle');
    const navLinks = document.getElementById('navLinks');
    const navbar = document.getElementById('navbar');
    
    if (!mobileToggle || !navLinks) return;

    mobileToggle.addEventListener('click', () => {
        navLinks.classList.toggle('active');
        mobileToggle.classList.toggle('active');
        
        // Animate hamburger to X
        const spans = mobileToggle.querySelectorAll('span');
        if (mobileToggle.classList.contains('active')) {
            spans[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
            spans[1].style.opacity = '0';
            spans[2].style.transform = 'rotate(-45deg) translate(5px, -5px)';
        } else {
            spans[0].style.transform = 'none';
            spans[1].style.opacity = '1';
            spans[2].style.transform = 'none';
        }
    });

    // Close menu when clicking a link
    navLinks.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            navLinks.classList.remove('active');
            mobileToggle.classList.remove('active');
            const spans = mobileToggle.querySelectorAll('span');
            spans[0].style.transform = 'none';
            spans[1].style.opacity = '1';
            spans[2].style.transform = 'none';
        });
    });

    // Navbar scroll effect
    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });
}

// ============================================
// SMOOTH SCROLL FOR ANCHOR LINKS
// ============================================
function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
}

// ============================================
// DEMO LOG ANIMATION
// ============================================
function initDemoLog() {
    const logEntries = document.querySelectorAll('.log-entry');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const index = Array.from(logEntries).indexOf(entry.target);
                setTimeout(() => {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                }, index * 150);
            }
        });
    }, { threshold: 0.5 });

    logEntries.forEach(entry => {
        entry.style.opacity = '0';
        entry.style.transform = 'translateY(10px)';
        entry.style.transition = 'all 0.5s ease';
        observer.observe(entry);
    });
}

// ============================================
// HERO PARALLAX EFFECT
// ============================================
function initHeroParallax() {
    const heroContent = document.querySelector('.hero-content');
    if (!heroContent) return;

    window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        const rate = scrolled * 0.3;
        heroContent.style.transform = `translateY(${rate}px)`;
        heroContent.style.opacity = 1 - (scrolled / 700);
    });
}

// ============================================
// PRICING CARD HOVER EFFECT
// ============================================
function initPricingHover() {
    const cards = document.querySelectorAll('.pricing-card');
    
    cards.forEach(card => {
        card.addEventListener('mouseenter', () => {
            cards.forEach(c => {
                if (c !== card) {
                    c.style.opacity = '0.7';
                    c.style.transform = 'scale(0.98)';
                }
            });
        });
        
        card.addEventListener('mouseleave', () => {
            cards.forEach(c => {
                c.style.opacity = '1';
                c.style.transform = '';
            });
        });
    });
}

// ============================================
// TYPING EFFECT FOR HERO SUBTITLE
// ============================================
function initTypingEffect() {
    const subtitle = document.querySelector('.hero-subtitle');
    if (!subtitle) return;
    
    const text = subtitle.textContent;
    subtitle.textContent = '';
    subtitle.style.minHeight = '1.6em';
    
    let i = 0;
    const typeWriter = () => {
        if (i < text.length) {
            subtitle.textContent += text.charAt(i);
            i++;
            setTimeout(typeWriter, 30);
        }
    };
    
    // Start typing after a short delay
    setTimeout(typeWriter, 500);
}

// ============================================
// COUNTER ANIMATION FOR STATS
// ============================================
function initCounterAnimation() {
    const statNumbers = document.querySelectorAll('.stat-number');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const target = entry.target;
                const text = target.textContent;
                const hasK = text.includes('K');
                const hasPercent = text.includes('%');
                const hasLessThan = text.includes('<');
                const hasMs = text.includes('ms');
                
                let numericValue = parseFloat(text.replace(/[^0-9.]/g, ''));
                let current = 0;
                const increment = numericValue / 50;
                const suffix = hasK ? 'K+' : hasPercent ? '%' : hasMs ? 'ms' : '';
                const prefix = hasLessThan ? '<' : '';
                
                const updateCounter = () => {
                    current += increment;
                    if (current < numericValue) {
                        if (hasMs) {
                            target.textContent = prefix + Math.floor(current) + suffix;
                        } else {
                            target.textContent = prefix + Math.floor(current) + suffix;
                        }
                        requestAnimationFrame(updateCounter);
                    } else {
                        target.textContent = text;
                    }
                };
                
                updateCounter();
                observer.unobserve(target);
            }
        });
    }, { threshold: 0.5 });

    statNumbers.forEach(stat => observer.observe(stat));
}

// ============================================
// FEATURE CARD TILT EFFECT
// ============================================
function initTiltEffect() {
    const cards = document.querySelectorAll('.feature-card');
    
    cards.forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            
            const rotateX = (y - centerY) / 20;
            const rotateY = (centerX - x) / 20;
            
            card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-4px)`;
        });
        
        card.addEventListener('mouseleave', () => {
            card.style.transform = 'perspective(1000px) rotateX(0) rotateY(0) translateY(0)';
        });
    });
}

// ============================================
// INITIALIZE EVERYTHING
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Three.js
    initThreeJS();
    animateThreeJS();
    
    // Initialize all features
    initScrollReveal();
    initMobileNav();
    initSmoothScroll();
    initDemoLog();
    initHeroParallax();
    initPricingHover();
    initTypingEffect();
    initCounterAnimation();
    initTiltEffect();
    
    // Add CSS class for revealed elements
    const style = document.createElement('style');
    style.textContent = `
        .section-header, .problem-card, .feature-card, 
        .workflow-step, .pricing-card, .demo-panel {
            opacity: 0;
            transform: translateY(40px);
            transition: all 0.8s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .section-header.revealed, .problem-card.revealed, 
        .feature-card.revealed, .workflow-step.revealed, 
        .pricing-card.revealed, .demo-panel.revealed {
            opacity: 1;
            transform: translateY(0);
        }
    `;
    document.head.appendChild(style);
});

/**
 * Agent Orcha - Main JavaScript
 * Handles navigation, scroll animations, and interactive elements
 */

(function() {
  'use strict';

  // ========== Mobile Navigation Toggle ==========
  function initMobileNav() {
    const navToggle = document.querySelector('.nav-toggle');
    const navLinks = document.querySelector('.nav-links');

    if (navToggle && navLinks) {
      navToggle.addEventListener('click', function() {
        navLinks.classList.toggle('active');

        // Update aria-expanded for accessibility
        const isExpanded = navLinks.classList.contains('active');
        navToggle.setAttribute('aria-expanded', isExpanded);
      });

      // Close menu when clicking a link
      const links = navLinks.querySelectorAll('a');
      links.forEach(function(link) {
        link.addEventListener('click', function() {
          navLinks.classList.remove('active');
          navToggle.setAttribute('aria-expanded', 'false');
        });
      });

      // Close menu when clicking outside
      document.addEventListener('click', function(event) {
        const isClickInsideNav = navToggle.contains(event.target) || navLinks.contains(event.target);
        if (!isClickInsideNav && navLinks.classList.contains('active')) {
          navLinks.classList.remove('active');
          navToggle.setAttribute('aria-expanded', 'false');
        }
      });
    }
  }

  // ========== Smooth Scrolling ==========
  function initSmoothScroll() {
    const links = document.querySelectorAll('a[href^="#"]');

    links.forEach(function(link) {
      link.addEventListener('click', function(e) {
        const href = this.getAttribute('href');

        // Skip if it's just "#"
        if (href === '#') {
          e.preventDefault();
          return;
        }

        const target = document.querySelector(href);

        if (target) {
          e.preventDefault();

          // Calculate offset for fixed nav
          const navHeight = document.querySelector('.nav')?.offsetHeight || 0;
          const targetPosition = target.getBoundingClientRect().top + window.pageYOffset - navHeight - 20;

          window.scrollTo({
            top: targetPosition,
            behavior: 'smooth'
          });

          // Update URL hash without jumping
          history.pushState(null, '', href);
        }
      });
    });
  }

  // ========== Scroll Animations ==========
  function initScrollAnimations() {
    const fadeElements = document.querySelectorAll('.fade-in');

    if ('IntersectionObserver' in window) {
      const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
      };

      const observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            // Stop observing after animation
            observer.unobserve(entry.target);
          }
        });
      }, observerOptions);

      fadeElements.forEach(function(element) {
        observer.observe(element);
      });
    } else {
      // Fallback for browsers without IntersectionObserver
      fadeElements.forEach(function(element) {
        element.classList.add('visible');
      });
    }
  }

  // ========== Expandable Sections (Documentation) ==========
  function initExpandables() {
    const expandables = document.querySelectorAll('.expandable');

    expandables.forEach(function(expandable) {
      const header = expandable.querySelector('.expandable-header');
      const content = expandable.querySelector('.expandable-content');

      if (header && content) {
        header.addEventListener('click', function() {
          // Toggle active state
          expandable.classList.toggle('active');

          // Update aria-expanded for accessibility
          const isExpanded = expandable.classList.contains('active');
          header.setAttribute('aria-expanded', isExpanded);

          // Set max-height for smooth animation
          if (isExpanded) {
            content.style.maxHeight = content.scrollHeight + 'px';
          } else {
            content.style.maxHeight = '0px';
          }
        });

        // Set initial max-height for active sections
        if (expandable.classList.contains('active')) {
          content.style.maxHeight = content.scrollHeight + 'px';
          header.setAttribute('aria-expanded', 'true');
        } else {
          header.setAttribute('aria-expanded', 'false');
        }
      }
    });

    // Recalculate heights on window resize
    let resizeTimer;
    window.addEventListener('resize', function() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function() {
        const activeExpandables = document.querySelectorAll('.expandable.active');
        activeExpandables.forEach(function(expandable) {
          const content = expandable.querySelector('.expandable-content');
          if (content) {
            content.style.maxHeight = content.scrollHeight + 'px';
          }
        });
      }, 250);
    });
  }

  // ========== Highlight Current Section in Docs Nav ==========
  function initDocsNavHighlight() {
    const docsNav = document.querySelector('.docs-nav');

    if (!docsNav) return;

    const sections = document.querySelectorAll('.docs-content h2[id], .docs-content h3[id], .docs-content h4[id]');
    const navLinks = docsNav.querySelectorAll('a');

    if ('IntersectionObserver' in window) {
      const observerOptions = {
        root: null,
        rootMargin: '-80px 0px -80% 0px',
        threshold: 0
      };

      const observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('id');

            // Remove active class from all links
            navLinks.forEach(function(link) {
              link.classList.remove('active');
            });

            // Add active class to current link
            const activeLink = docsNav.querySelector(`a[href="#${id}"]`);
            if (activeLink) {
              activeLink.classList.add('active');

              // Update URL hash to match current section
              history.replaceState(null, '', `#${id}`);
            }
          }
        });
      }, observerOptions);

      sections.forEach(function(section) {
        observer.observe(section);
      });
    }
  }

  // ========== Back to Top Button ==========
  function initBackToTop() {
    const backToTopBtn = document.getElementById('back-to-top');

    if (!backToTopBtn) return;

    window.addEventListener('scroll', function() {
      if (window.pageYOffset > 300) {
        backToTopBtn.classList.add('visible');
      } else {
        backToTopBtn.classList.remove('visible');
      }
    });

    backToTopBtn.addEventListener('click', function() {
      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    });
  }

  // ========== Initialize Everything ==========
  function init() {
    // Wait for DOM to be fully loaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        initMobileNav();
        initSmoothScroll();
        initScrollAnimations();
        initExpandables();
        initDocsNavHighlight();
        initBackToTop();
      });
    } else {
      // DOM is already loaded
      initMobileNav();
      initSmoothScroll();
      initScrollAnimations();
      initExpandables();
      initDocsNavHighlight();
      initBackToTop();
    }
  }

  // Start initialization
  init();

})();

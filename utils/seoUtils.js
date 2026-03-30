// utils/seoUtils.js

/**
 * Auto-generate SEO data from product information
 * This runs automatically - no staff intervention needed
 */
const generateSEOData = (productData) => {
    try {
        // Get clean description (remove HTML tags)
        const cleanDescription = productData.description 
            ? productData.description.replace(/<[^>]*>/g, '').substring(0, 160)
            : '';
        
        // Get first variant image for OG image
        let firstImage = null;
        if (productData.variants && productData.variants.length > 0) {
            const firstVariant = productData.variants[0];
            if (firstVariant.images && firstVariant.images.length > 0) {
                firstImage = firstVariant.images[0].url;
            }
        }
        
        // Get category name
        const categoryName = productData.category?.name || productData.category || 'Product';
        
        // Get best price for meta title
        let bestPrice = '';
        if (productData.variants && productData.variants.length > 0) {
            const prices = productData.variants.map(v => 
                v.price.sale != null ? v.price.sale : v.price.base
            );
            const minPrice = Math.min(...prices);
            bestPrice = ` at ₹${minPrice}`;
        }
        
        // =============================================
        // 1. META TITLE (50-60 characters)
        // =============================================
        let metaTitle = `${productData.name}${bestPrice} | Buy Online | OfferWaleBaba`;
        if (metaTitle.length > 60) {
            metaTitle = metaTitle.substring(0, 57) + '...';
        }
        
        // =============================================
        // 2. META DESCRIPTION (150-160 characters)
        // =============================================
        let metaDescription = `${productData.name} - ${cleanDescription || 'Premium quality product'}. ✓ Free Shipping ✓ COD ✓ Easy Returns. Best price guaranteed!`;
        if (metaDescription.length > 160) {
            metaDescription = metaDescription.substring(0, 157) + '...';
        }
        
        // =============================================
        // 3. META KEYWORDS
        // =============================================
        const metaKeywords = `${productData.name}, ${categoryName}, buy online, best price, shop now, ecommerce`;
        
        // =============================================
        // 4. OG TITLE (For social media - max 60 chars)
        // =============================================
        let ogTitle = `${productData.name}${bestPrice}`;
        if (ogTitle.length > 60) {
            ogTitle = ogTitle.substring(0, 57) + '...';
        }
        
        // =============================================
        // 5. OG DESCRIPTION (For social media - max 200 chars)
        // =============================================
        let ogDescription = cleanDescription || productData.name;
        if (ogDescription.length > 200) {
            ogDescription = ogDescription.substring(0, 197) + '...';
        }
        
        // =============================================
        // 6. OG IMAGE
        // =============================================
        const ogImage = firstImage;


        // =============================================
        // 7. CANONICAL URL (NEW - Added logic)
        // =============================================
        // Get base URL from environment or use default
        const baseUrl = process.env.FRONTEND_URL || 'https://yourstore.com';
        
        // Build canonical URL using product slug
        let canonicalUrl = null;
        if (productData.slug) {
            canonicalUrl = `${baseUrl}/product/${productData.slug}`;
        } else if (productData.name) {
            // If no slug, generate from name (fallback)
            const fallbackSlug = productData.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            canonicalUrl = `${baseUrl}/product/${fallbackSlug}`;
        }
        
        return {
            meta_title: metaTitle,
            meta_description: metaDescription,
            meta_keywords: metaKeywords,
            og_title: ogTitle,
            og_description: ogDescription,
            og_image: ogImage,
            canonical_url: canonicalUrl
        };
        
    } catch (error) {
        console.error('Error generating SEO data:', error);
        // Return default SEO if something fails
        return {
            meta_title: `${productData.name || 'Product'} | Buy Online | OfferWaleBaba`,
            meta_description: 'Shop now for best prices with free shipping and COD',
            meta_keywords: 'buy online, best price, shop now',
            og_title: productData.name || 'Product',
            og_description: 'Shop now for best prices',
            og_image: null,
            canonical_url:  productData.slug 
                ? `${baseUrl}/product/${productData.slug}`
                : null
        };
    }
};

module.exports = { generateSEOData };
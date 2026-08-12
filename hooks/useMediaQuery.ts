"use client";

import { useEffect, useState } from "react";

export function useMediaQuery(query: string, initialValue = false) {
    const [matches, setMatches] = useState(initialValue);

    useEffect(() => {
        const mediaQuery = window.matchMedia(query);
        const updateMatch = () => setMatches(mediaQuery.matches);

        updateMatch();
        mediaQuery.addEventListener("change", updateMatch);
        return () => mediaQuery.removeEventListener("change", updateMatch);
    }, [query]);

    return matches;
}
